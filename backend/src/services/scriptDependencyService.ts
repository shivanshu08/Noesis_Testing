import { query } from '../database/connection';

interface ScriptDependencyRow {
  script_id: number;
  depends_on_script_id: number;
}

interface ScriptActiveRow {
  id: number;
  is_active: boolean;
}

export interface ScriptDependencyEdge {
  scriptId: number;
  dependsOnScriptId: number;
}

export interface ScriptDependencyExecutionPlan {
  requestedScriptIds: number[];
  orderedScriptIds: number[];
  autoIncludedDependencyIds: number[];
  missingScriptIds: number[];
  cyclePath: number[] | null;
  dependencyMap: Map<number, number[]>;
}

let ensureScriptDependencyStorePromise: Promise<void> | null = null;

export function normalizeScriptIdArray(values: unknown[]): number[] {
  const normalized = values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => Math.trunc(value));

  return Array.from(new Set(normalized));
}

function buildDependencyMap(edges: ScriptDependencyEdge[]): Map<number, number[]> {
  const map = new Map<number, number[]>();

  for (const edge of edges) {
    const deps = map.get(edge.scriptId) || [];
    deps.push(edge.dependsOnScriptId);
    map.set(edge.scriptId, deps);

    if (!map.has(edge.dependsOnScriptId)) {
      map.set(edge.dependsOnScriptId, []);
    }
  }

  for (const [scriptId, deps] of map.entries()) {
    const uniqueDeps = Array.from(new Set(deps)).filter((depId) => depId !== scriptId);
    map.set(scriptId, uniqueDeps);
  }

  return map;
}

function buildPriorityComparator(requestedScriptIds: number[]): (a: number, b: number) => number {
  const priority = new Map<number, number>();
  for (let i = 0; i < requestedScriptIds.length; i++) {
    priority.set(requestedScriptIds[i], i);
  }

  return (a: number, b: number) => {
    const aPriority = priority.has(a) ? priority.get(a)! : Number.MAX_SAFE_INTEGER;
    const bPriority = priority.has(b) ? priority.get(b)! : Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a - b;
  };
}

function normalizeDependencyMap(
  rawMap: Map<number, number[]>,
  comparator: (a: number, b: number) => number
): Map<number, number[]> {
  const normalizedMap = new Map<number, number[]>();

  for (const [scriptId, deps] of rawMap.entries()) {
    const uniqueSortedDeps = Array.from(new Set(deps)).sort(comparator);
    normalizedMap.set(scriptId, uniqueSortedDeps);
  }

  return normalizedMap;
}

function detectCyclePath(
  dependencyMap: Map<number, number[]>,
  startNodes: number[],
  comparator: (a: number, b: number) => number
): number[] | null {
  const state = new Map<number, 0 | 1 | 2>();
  const stack: number[] = [];
  const stackIndex = new Map<number, number>();

  const dfs = (node: number): number[] | null => {
    state.set(node, 1);
    stackIndex.set(node, stack.length);
    stack.push(node);

    const deps = [...(dependencyMap.get(node) || [])].sort(comparator);
    for (const dep of deps) {
      const depState = state.get(dep) || 0;

      if (depState === 0) {
        const nestedCycle = dfs(dep);
        if (nestedCycle) {
          return nestedCycle;
        }
      } else if (depState === 1) {
        const cycleStartIndex = stackIndex.get(dep) ?? 0;
        return [...stack.slice(cycleStartIndex), dep];
      }
    }

    stack.pop();
    stackIndex.delete(node);
    state.set(node, 2);
    return null;
  };

  const uniqueStartNodes = Array.from(new Set(startNodes));
  for (const node of uniqueStartNodes) {
    if (!state.has(node)) {
      const cycle = dfs(node);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

function buildExecutionOrder(
  dependencyMap: Map<number, number[]>,
  requestedScriptIds: number[],
  comparator: (a: number, b: number) => number
): number[] {
  const visited = new Set<number>();
  const ordered: number[] = [];

  const dfs = (scriptId: number): void => {
    if (visited.has(scriptId)) {
      return;
    }
    visited.add(scriptId);

    const deps = [...(dependencyMap.get(scriptId) || [])].sort(comparator);
    for (const depId of deps) {
      dfs(depId);
    }

    ordered.push(scriptId);
  };

  for (const scriptId of requestedScriptIds) {
    dfs(scriptId);
  }

  return ordered;
}

async function getDependencyClosureEdges(scriptIds: number[]): Promise<ScriptDependencyEdge[]> {
  if (scriptIds.length === 0) return [];

  const rows = await query<ScriptDependencyRow>(
    `
      WITH RECURSIVE dependency_tree AS (
        SELECT sd.script_id, sd.depends_on_script_id
        FROM script_dependencies sd
        WHERE sd.script_id = ANY($1::int[])

        UNION

        SELECT sd.script_id, sd.depends_on_script_id
        FROM script_dependencies sd
        INNER JOIN dependency_tree dt ON sd.script_id = dt.depends_on_script_id
      )
      SELECT DISTINCT script_id, depends_on_script_id
      FROM dependency_tree
    `,
    [scriptIds]
  );

  return rows.map((row) => ({
    scriptId: row.script_id,
    dependsOnScriptId: row.depends_on_script_id,
  }));
}

export async function ensureScriptDependencyStore(): Promise<void> {
  if (!ensureScriptDependencyStorePromise) {
    ensureScriptDependencyStorePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS script_dependencies (
          id BIGSERIAL PRIMARY KEY,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          depends_on_script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT script_dependencies_no_self_dependency CHECK (script_id <> depends_on_script_id),
          UNIQUE (script_id, depends_on_script_id)
        )
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_script_dependencies_script ON script_dependencies(script_id)');
      await query('CREATE INDEX IF NOT EXISTS idx_script_dependencies_depends_on ON script_dependencies(depends_on_script_id)');
    })().catch((error) => {
      ensureScriptDependencyStorePromise = null;
      throw error;
    });
  }

  await ensureScriptDependencyStorePromise;
}

export async function listScriptDependencyEdges(scriptIds?: number[]): Promise<ScriptDependencyEdge[]> {
  await ensureScriptDependencyStore();

  if (Array.isArray(scriptIds) && scriptIds.length === 0) {
    return [];
  }

  let rows: ScriptDependencyRow[] = [];
  if (Array.isArray(scriptIds) && scriptIds.length > 0) {
    rows = await query<ScriptDependencyRow>(
      `
        SELECT script_id, depends_on_script_id
        FROM script_dependencies
        WHERE script_id = ANY($1::int[])
        ORDER BY script_id, depends_on_script_id
      `,
      [scriptIds]
    );
  } else {
    rows = await query<ScriptDependencyRow>(
      `
        SELECT script_id, depends_on_script_id
        FROM script_dependencies
        ORDER BY script_id, depends_on_script_id
      `
    );
  }

  return rows.map((row) => ({
    scriptId: row.script_id,
    dependsOnScriptId: row.depends_on_script_id,
  }));
}

export async function getScriptDependencyMap(scriptIds?: number[]): Promise<Map<number, number[]>> {
  const normalizedScriptIds = Array.isArray(scriptIds) ? normalizeScriptIdArray(scriptIds) : undefined;
  const edges = await listScriptDependencyEdges(normalizedScriptIds);
  const map = buildDependencyMap(edges);

  if (normalizedScriptIds) {
    for (const scriptId of normalizedScriptIds) {
      if (!map.has(scriptId)) {
        map.set(scriptId, []);
      }
    }
  }

  return map;
}

export async function resolveScriptExecutionPlan(inputScriptIdsRaw: unknown[]): Promise<ScriptDependencyExecutionPlan> {
  const requestedScriptIds = normalizeScriptIdArray(inputScriptIdsRaw);
  if (requestedScriptIds.length === 0) {
    return {
      requestedScriptIds: [],
      orderedScriptIds: [],
      autoIncludedDependencyIds: [],
      missingScriptIds: [],
      cyclePath: null,
      dependencyMap: new Map<number, number[]>(),
    };
  }

  await ensureScriptDependencyStore();

  const edges = await getDependencyClosureEdges(requestedScriptIds);
  const rawDependencyMap = buildDependencyMap(edges);

  for (const scriptId of requestedScriptIds) {
    if (!rawDependencyMap.has(scriptId)) {
      rawDependencyMap.set(scriptId, []);
    }
  }

  const requiredScriptIdsSet = new Set<number>(requestedScriptIds);
  for (const edge of edges) {
    requiredScriptIdsSet.add(edge.scriptId);
    requiredScriptIdsSet.add(edge.dependsOnScriptId);
  }
  const requiredScriptIds = Array.from(requiredScriptIdsSet);

  const scriptRows = requiredScriptIds.length > 0
    ? await query<ScriptActiveRow>(
      `SELECT id, is_active FROM scripts WHERE id = ANY($1::int[])`,
      [requiredScriptIds]
    )
    : [];

  const activeScriptIds = new Set<number>(
    scriptRows.filter((row) => row.is_active).map((row) => row.id)
  );

  const missingScriptIds = requiredScriptIds
    .filter((scriptId) => !activeScriptIds.has(scriptId))
    .sort((a, b) => a - b);

  const filteredDependencyMap = new Map<number, number[]>();
  for (const [scriptId, deps] of rawDependencyMap.entries()) {
    if (!activeScriptIds.has(scriptId)) {
      continue;
    }
    filteredDependencyMap.set(
      scriptId,
      deps.filter((depId) => activeScriptIds.has(depId))
    );
  }

  if (missingScriptIds.length > 0) {
    return {
      requestedScriptIds,
      orderedScriptIds: [],
      autoIncludedDependencyIds: [],
      missingScriptIds,
      cyclePath: null,
      dependencyMap: filteredDependencyMap,
    };
  }

  const comparator = buildPriorityComparator(requestedScriptIds);
  const dependencyMap = normalizeDependencyMap(filteredDependencyMap, comparator);
  const cyclePath = detectCyclePath(dependencyMap, requestedScriptIds, comparator);

  if (cyclePath) {
    return {
      requestedScriptIds,
      orderedScriptIds: [],
      autoIncludedDependencyIds: [],
      missingScriptIds: [],
      cyclePath,
      dependencyMap,
    };
  }

  const orderedScriptIds = buildExecutionOrder(dependencyMap, requestedScriptIds, comparator);
  const requestedIdSet = new Set<number>(requestedScriptIds);
  const autoIncludedDependencyIds = orderedScriptIds.filter((id) => !requestedIdSet.has(id));

  return {
    requestedScriptIds,
    orderedScriptIds,
    autoIncludedDependencyIds,
    missingScriptIds: [],
    cyclePath: null,
    dependencyMap,
  };
}

export async function detectCycleForProposedDependencies(
  scriptIdRaw: number,
  proposedDependencyIdsRaw: unknown[]
): Promise<number[] | null> {
  const scriptIdList = normalizeScriptIdArray([scriptIdRaw]);
  if (scriptIdList.length === 0) {
    return null;
  }
  const scriptId = scriptIdList[0];

  const proposedDependencyIds = normalizeScriptIdArray(proposedDependencyIdsRaw).filter((id) => id !== scriptId);
  const existingEdges = await listScriptDependencyEdges();
  const map = buildDependencyMap(existingEdges);

  map.set(scriptId, proposedDependencyIds);
  if (!map.has(scriptId)) {
    map.set(scriptId, []);
  }
  for (const dependencyId of proposedDependencyIds) {
    if (!map.has(dependencyId)) {
      map.set(dependencyId, []);
    }
  }

  const comparator = buildPriorityComparator([scriptId, ...proposedDependencyIds]);
  const normalizedMap = normalizeDependencyMap(map, comparator);
  return detectCyclePath(normalizedMap, [scriptId], comparator);
}
