const fs = require('fs');

let data = fs.readFileSync('src/routes/execution.ts', 'utf8');

// 1. POST schedule definition
data = data.replace(
  /const \{ name, scriptIds, suiteId, cronExpression, environment = 'local', description \} = req\.body;/,
  "const { name, scriptIds, suiteId, cronExpression, environment = 'local', description, isOneTime = false } = req.body;"
);

// 2. INSERT statement
data = data.replace(
  /INSERT INTO scheduled_runs \(name, suite_id, script_ids, cron_expression, environment, description, next_run_at, created_by\)\s*VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\) RETURNING \*/,
  "INSERT INTO scheduled_runs (name, suite_id, script_ids, cron_expression, environment, description, is_one_time, next_run_at, created_by)\\n       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *"
);

// 3. INSERT parameters
data = data.replace(
  /description \|\| null,\s*nextRunAt,\s*req\.userId,/,
  "description || null,\n        isOneTime,\n        nextRunAt,\n        req.userId,"
);

// 4. GET formatting
data = data.replace(
  /description: created\.description,\s*isActive: created\.is_active,/,
  "description: created.description,\n      isOneTime: created.is_one_time,\n      isActive: created.is_active,"
);

data = data.replace(
  /description: r\.description,\s*isActive: r\.is_active,/,
  "description: r.description,\n      isOneTime: r.is_one_time,\n      isActive: r.is_active,"
);

// 5. PUT definition
data = data.replace(
  /const \{ name, cronExpression, isActive, environment, description \} = req\.body;/,
  "const { name, cronExpression, isActive, environment, description, isOneTime } = req.body;"
);

// 6. PUT variables
const putVarMatch = /if \(description !== undefined\) \{\s*sets\.push\(`description = \$\$\{idx\+\+\}`\);\s*params\.push\(description\);\s*\}/;
data = data.replace(
  putVarMatch,
  "if (description !== undefined) {\n      sets.push(`description = $${idx++}`);\n      params.push(description);\n    }\n    if (isOneTime !== undefined) {\n      sets.push(`is_one_time = $${idx++}`);\n      params.push(isOneTime);\n    }"
);

fs.writeFileSync('src/routes/execution.ts', data);
console.log('Patched execution.ts successfully!');
