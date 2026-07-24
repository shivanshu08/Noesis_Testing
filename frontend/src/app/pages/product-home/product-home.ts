import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-product-home',
  standalone: true,
  templateUrl: './product-home.html',
  styleUrl: './product-home.scss'
})
export class ProductHome {
  private readonly route = inject(ActivatedRoute);
  private readonly platform = this.route.snapshot.paramMap.get('platform');
  readonly title = this.platform === 'csd-studio' ? 'CSD Studio' : 'Tenant Provisioning';
  readonly description = this.platform === 'csd-studio'
    ? 'Document generation workspace'
    : 'Tenant creation and provisioning workspace';
  readonly icon = this.platform === 'csd-studio' ? 'pi pi-file-edit' : 'pi pi-cog';
}