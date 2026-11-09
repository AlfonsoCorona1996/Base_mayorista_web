import { Injectable, inject } from '@angular/core';
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore';
import { FIRESTORE } from './firebase.providers';
import { AuthzService } from './authz.service';
import { BusinessScopeService } from './business-scope.service';
import { BusinessId } from './rbac.constants';
import { FinanceCommitment, validateCommitment } from './finance-commitments';

@Injectable({ providedIn: 'root' })
export class FinanceCommitmentsService {
  private readonly plans = collection(FIRESTORE, 'finance_commitments');
  private readonly authz = inject(AuthzService);
  private readonly businesses = inject(BusinessScopeService);

  async load(businessId: BusinessId): Promise<FinanceCommitment[]> {
    if (!this.businesses.canAccessBusiness(businessId)) throw new Error('No tienes acceso a este negocio.');
    const snap = await getDocs(query(this.plans, where('business_id', '==', businessId)));
    return snap.docs.map(row => ({ ...row.data(), commitment_id: row.id } as FinanceCommitment));
  }

  async save(plan: FinanceCommitment, creating: boolean): Promise<void> {
    validateCommitment(plan);
    if (!this.businesses.canAccessBusiness(plan.business_id) || !this.authz.canCap(creating ? 'cap.finance.movements.create' : 'cap.finance.movements.edit')) throw new Error('No tienes permiso para guardar este compromiso.');
    const ref = doc(this.plans, plan.commitment_id);
    await runTransaction(FIRESTORE, async tx => {
      const previous = await tx.get(ref);
      if (creating && previous.exists()) throw new Error('Este compromiso ya se guardó. Actualiza la lista antes de continuar.');
      if (!creating && (!previous.exists() || previous.data()['business_id'] !== plan.business_id || previous.data()['revision'] !== plan.revision)) throw new Error('El compromiso cambió en otra sesión. Actualiza la lista antes de editarlo.');
      if (!creating && ['frequency', 'start_date', 'end_date', 'route_id'].some(key => previous.data()?.[key] !== plan[key as keyof FinanceCommitment])) throw new Error('La frecuencia y el alcance de un compromiso existente no se pueden cambiar.');
      tx.set(ref, { ...plan, revision: plan.revision + 1, updated_at: serverTimestamp(), created_at: previous.data()?.['created_at'] || serverTimestamp() });
    });
  }
}
