import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';

export type AdministrationPrototypeView = 'resumen' | 'mensual' | 'inventario' | 'socios';
export type PartnerPrototypeScope = 'general' | 'mensual';
export type AdministrationPrototypeBusiness = 'bm' | 'catalogo';

interface MonthlyFinanceSnapshot {
  id: string;
  label: string;
  shortLabel: string;
  investment: number;
  generatedSales: number;
  generatedOrderCount: number;
  netSales: number;
  collected: number;
  merchandiseCost: number;
  expenses: number;
  returnsImpact: number;
  netProfit: number;
  collectedProfit: number;
  inProcessProfit: number;
  pendingCollectionProfit: number;
  projectedProfit: number;
  inProcessOrderCount: number;
  pendingCollectionOrderCount: number;
  cohortCollectedToDate: number;
  cohortPendingToday: number;
  cohortCollectedAfterPeriod: number;
  collectedFromCurrentPeriod: number;
  collectedFromPriorPeriods: number;
  receivablesOpening: number;
  receivablesClosing: number;
  distributableProfit: number;
  overdue: number;
  dso: number;
  partnerOneWithdrawn: number;
  partnerTwoWithdrawn: number;
  inventoryOpening: number;
  inventoryReceipts: number;
  returnedToInventory: number;
  inventoryReleased: number;
  inventoryRecovered: number;
  inventoryWriteOff: number;
  inventoryClosing: number;
  stagnantCapital: number;
}

const MONTHS: readonly MonthlyFinanceSnapshot[] = [
  {
    id: 'mar-2026',
    label: 'Marzo 2026',
    shortLabel: 'Mar',
    investment: 31_500,
    generatedSales: 55_800,
    generatedOrderCount: 28,
    netSales: 49_300,
    collected: 44_820,
    merchandiseCost: 28_100,
    expenses: 9_100,
    returnsImpact: 2_500,
    netProfit: 9_600,
    collectedProfit: 8_200,
    inProcessProfit: 2_600,
    pendingCollectionProfit: 1_400,
    projectedProfit: 12_200,
    inProcessOrderCount: 4,
    pendingCollectionOrderCount: 3,
    cohortCollectedToDate: 49_300,
    cohortPendingToday: 6_500,
    cohortCollectedAfterPeriod: 7_300,
    collectedFromCurrentPeriod: 44_820,
    collectedFromPriorPeriods: 0,
    receivablesOpening: 0,
    receivablesClosing: 4_480,
    distributableProfit: 9_600,
    overdue: 21_400,
    dso: 20.8,
    partnerOneWithdrawn: 4_800,
    partnerTwoWithdrawn: 4_800,
    inventoryOpening: 31_000,
    inventoryReceipts: 10_000,
    returnedToInventory: 1_200,
    inventoryReleased: 9_500,
    inventoryRecovered: 8_200,
    inventoryWriteOff: 300,
    inventoryClosing: 32_400,
    stagnantCapital: 14_900,
  },
  {
    id: 'abr-2026',
    label: 'Abril 2026',
    shortLabel: 'Abr',
    investment: 34_200,
    generatedSales: 61_400,
    generatedOrderCount: 31,
    netSales: 52_600,
    collected: 48_600,
    merchandiseCost: 30_000,
    expenses: 10_400,
    returnsImpact: 2_100,
    netProfit: 10_100,
    collectedProfit: 8_900,
    inProcessProfit: 3_100,
    pendingCollectionProfit: 1_300,
    projectedProfit: 13_200,
    inProcessOrderCount: 5,
    pendingCollectionOrderCount: 2,
    cohortCollectedToDate: 52_100,
    cohortPendingToday: 9_300,
    cohortCollectedAfterPeriod: 11_100,
    collectedFromCurrentPeriod: 42_600,
    collectedFromPriorPeriods: 6_000,
    receivablesOpening: 4_480,
    receivablesClosing: 8_480,
    distributableProfit: 10_100,
    overdue: 20_100,
    dso: 19.4,
    partnerOneWithdrawn: 5_050,
    partnerTwoWithdrawn: 5_050,
    inventoryOpening: 32_400,
    inventoryReceipts: 11_500,
    returnedToInventory: 1_000,
    inventoryReleased: 10_800,
    inventoryRecovered: 9_600,
    inventoryWriteOff: 400,
    inventoryClosing: 33_700,
    stagnantCapital: 15_200,
  },
  {
    id: 'may-2026',
    label: 'Mayo 2026',
    shortLabel: 'May',
    investment: 38_100,
    generatedSales: 72_900,
    generatedOrderCount: 36,
    netSales: 60_100,
    collected: 54_300,
    merchandiseCost: 34_100,
    expenses: 11_000,
    returnsImpact: 2_400,
    netProfit: 12_600,
    collectedProfit: 10_500,
    inProcessProfit: 4_200,
    pendingCollectionProfit: 1_800,
    projectedProfit: 16_800,
    inProcessOrderCount: 6,
    pendingCollectionOrderCount: 4,
    cohortCollectedToDate: 59_000,
    cohortPendingToday: 13_900,
    cohortCollectedAfterPeriod: 15_000,
    collectedFromCurrentPeriod: 45_800,
    collectedFromPriorPeriods: 8_500,
    receivablesOpening: 8_480,
    receivablesClosing: 14_280,
    distributableProfit: 12_600,
    overdue: 18_700,
    dso: 18.2,
    partnerOneWithdrawn: 6_300,
    partnerTwoWithdrawn: 6_300,
    inventoryOpening: 33_700,
    inventoryReceipts: 14_200,
    returnedToInventory: 1_400,
    inventoryReleased: 12_700,
    inventoryRecovered: 11_100,
    inventoryWriteOff: 450,
    inventoryClosing: 36_150,
    stagnantCapital: 15_700,
  },
  {
    id: 'jun-2026',
    label: 'Junio 2026',
    shortLabel: 'Jun',
    investment: 35_500,
    generatedSales: 66_500,
    generatedOrderCount: 34,
    netSales: 58_900,
    collected: 57_240,
    merchandiseCost: 33_600,
    expenses: 11_200,
    returnsImpact: 2_200,
    netProfit: 11_900,
    collectedProfit: 11_100,
    inProcessProfit: 2_900,
    pendingCollectionProfit: 520,
    projectedProfit: 14_800,
    inProcessOrderCount: 4,
    pendingCollectionOrderCount: 1,
    cohortCollectedToDate: 58_000,
    cohortPendingToday: 8_500,
    cohortCollectedAfterPeriod: 8_000,
    collectedFromCurrentPeriod: 51_000,
    collectedFromPriorPeriods: 6_240,
    receivablesOpening: 14_280,
    receivablesClosing: 15_940,
    distributableProfit: 11_900,
    overdue: 16_900,
    dso: 17.1,
    partnerOneWithdrawn: 5_950,
    partnerTwoWithdrawn: 5_950,
    inventoryOpening: 36_150,
    inventoryReceipts: 12_500,
    returnedToInventory: 1_100,
    inventoryReleased: 13_200,
    inventoryRecovered: 12_400,
    inventoryWriteOff: 350,
    inventoryClosing: 36_200,
    stagnantCapital: 16_200,
  },
  {
    id: 'jul-2026',
    label: 'Julio 2026',
    shortLabel: 'Jul',
    investment: 41_600,
    generatedSales: 86_750,
    generatedOrderCount: 43,
    netSales: 68_750,
    collected: 63_120,
    merchandiseCost: 39_260,
    expenses: 11_850,
    returnsImpact: 2_300,
    netProfit: 15_340,
    collectedProfit: 13_200,
    inProcessProfit: 4_800,
    pendingCollectionProfit: 2_100,
    projectedProfit: 20_140,
    inProcessOrderCount: 7,
    pendingCollectionOrderCount: 4,
    cohortCollectedToDate: 63_750,
    cohortPendingToday: 23_000,
    cohortCollectedAfterPeriod: 9_750,
    collectedFromCurrentPeriod: 55_000,
    collectedFromPriorPeriods: 8_120,
    receivablesOpening: 15_940,
    receivablesClosing: 21_570,
    distributableProfit: 15_340,
    overdue: 14_800,
    dso: 15.7,
    partnerOneWithdrawn: 7_670,
    partnerTwoWithdrawn: 7_670,
    inventoryOpening: 36_200,
    inventoryReceipts: 18_400,
    returnedToInventory: 1_800,
    inventoryReleased: 13_320,
    inventoryRecovered: 12_100,
    inventoryWriteOff: 400,
    inventoryClosing: 42_680,
    stagnantCapital: 15_100,
  },
  {
    id: 'ago-2026',
    label: 'Agosto 2026',
    shortLabel: 'Ago',
    investment: 48_260,
    generatedSales: 104_240,
    generatedOrderCount: 51,
    netSales: 78_240,
    collected: 68_900,
    merchandiseCost: 45_120,
    expenses: 12_700,
    returnsImpact: 2_000,
    netProfit: 18_420,
    collectedProfit: 14_900,
    inProcessProfit: 6_200,
    pendingCollectionProfit: 3_100,
    projectedProfit: 24_620,
    inProcessOrderCount: 9,
    pendingCollectionOrderCount: 5,
    cohortCollectedToDate: 65_810,
    cohortPendingToday: 38_430,
    cohortCollectedAfterPeriod: 0,
    collectedFromCurrentPeriod: 57_000,
    collectedFromPriorPeriods: 11_900,
    receivablesOpening: 21_570,
    receivablesClosing: 30_910,
    distributableProfit: 18_420,
    overdue: 12_430,
    dso: 14.2,
    partnerOneWithdrawn: 7_000,
    partnerTwoWithdrawn: 9_210,
    inventoryOpening: 42_680,
    inventoryReceipts: 19_800,
    returnedToInventory: 2_640,
    inventoryReleased: 17_920,
    inventoryRecovered: 15_840,
    inventoryWriteOff: 680,
    inventoryClosing: 46_520,
    stagnantCapital: 13_640,
  },
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: 'app-administracion-redesign-prototype',
  templateUrl: './administracion-redesign-prototype.component.html',
  styleUrl: './administracion-redesign-prototype.component.css',
})
export class AdministracionRedesignPrototypeComponent {
  readonly initialView = input<AdministrationPrototypeView>('resumen');
  readonly initialPartnerScope = input<PartnerPrototypeScope>('general');
  readonly initialBusiness = input<AdministrationPrototypeBusiness>('bm');
  readonly activeView = signal<AdministrationPrototypeView>('resumen');
  readonly partnerScope = signal<PartnerPrototypeScope>('general');
  readonly selectedMonthId = signal('ago-2026');
  readonly loading = signal(false);
  readonly routeScope = signal('general');
  readonly scopeOptions = computed(() => [
    { id: 'general', name: 'General' },
    { id: 'durango-centro', name: 'Durango Centro' },
    { id: 'gomez-palacio', name: 'Gómez Palacio' },
    { id: 'santiago-papasquiaro', name: 'Santiago Papasquiaro' },
  ]);
  readonly months = MONTHS;
  readonly activeBusinessLabel = computed(() => this.initialBusiness() === 'catalogo' ? 'Catálogo' : 'Base Mayorista');

  readonly selectedMonth = computed(
    () => MONTHS.find((month) => month.id === this.selectedMonthId()) ?? MONTHS[MONTHS.length - 1],
  );

  readonly previousMonth = computed(() => {
    const currentIndex = MONTHS.findIndex((month) => month.id === this.selectedMonthId());
    return MONTHS[Math.max(0, currentIndex - 1)];
  });

  readonly netSalesDelta = computed(() => this.percentageDelta(this.selectedMonth().netSales, this.previousMonth().netSales));
  readonly netProfitDelta = computed(() => this.percentageDelta(this.selectedMonth().netProfit, this.previousMonth().netProfit));
  readonly margin = computed(() => (this.selectedMonth().netSales > 0 ? this.selectedMonth().netProfit / this.selectedMonth().netSales : 0));
  readonly distributableProfit = computed(() => Math.max(0, this.selectedMonth().netProfit));
  readonly sharePerPartner = computed(() => this.distributableProfit() / 2);
  readonly partnerOnePending = computed(() => this.sharePerPartner() - this.selectedMonth().partnerOneWithdrawn);
  readonly partnerTwoPending = computed(() => this.sharePerPartner() - this.selectedMonth().partnerTwoWithdrawn);
  readonly monthlyDistributionAdjustments = computed(
    () => this.selectedMonth().expenses + this.selectedMonth().returnsImpact,
  );
  readonly monthlyRecoveredPrincipal = computed(
    () => Math.max(0, this.selectedMonth().collected - this.monthlyDistributionAdjustments() - this.distributableProfit()),
  );
  readonly totalDistributableProfit = computed(() => MONTHS.reduce((sum, month) => sum + month.netProfit, 0));
  readonly totalInProcessProfit = computed(() => MONTHS.reduce((sum, month) => sum + month.inProcessProfit, 0));
  readonly totalProjectedProfit = computed(() => this.totalDistributableProfit() + this.totalInProcessProfit());
  readonly totalPendingCollectionProfit = computed(() => MONTHS.reduce((sum, month) => sum + month.pendingCollectionProfit, 0));
  readonly totalInProcessOrderCount = computed(() => MONTHS.reduce((sum, month) => sum + month.inProcessOrderCount, 0));
  readonly totalCollected = computed(() => MONTHS.reduce((sum, month) => sum + month.collected, 0));
  readonly totalDistributionAdjustments = computed(
    () => MONTHS.reduce((sum, month) => sum + month.expenses + month.returnsImpact, 0),
  );
  readonly totalRecoveredPrincipal = computed(
    () => Math.max(0, this.totalCollected() - this.totalDistributionAdjustments() - this.totalDistributableProfit()),
  );
  readonly totalSharePerPartner = computed(() => this.totalDistributableProfit() / 2);
  readonly totalPartnerOneWithdrawn = computed(() => MONTHS.reduce((sum, month) => sum + month.partnerOneWithdrawn, 0));
  readonly totalPartnerTwoWithdrawn = computed(() => MONTHS.reduce((sum, month) => sum + month.partnerTwoWithdrawn, 0));
  readonly totalPartnerOnePending = computed(() => this.totalSharePerPartner() - this.totalPartnerOneWithdrawn());
  readonly totalPartnerTwoPending = computed(() => this.totalSharePerPartner() - this.totalPartnerTwoWithdrawn());
  readonly totalDistributed = computed(() => this.totalPartnerOneWithdrawn() + this.totalPartnerTwoWithdrawn());
  readonly totalPendingDistribution = computed(
    () => this.totalPartnerOnePending() + this.totalPartnerTwoPending(),
  );
  readonly inventoryCapitalDelta = computed(() => this.selectedMonth().inventoryClosing - this.selectedMonth().inventoryOpening);
  readonly inventoryRecoveryRate = computed(() => {
    const released = this.selectedMonth().inventoryReleased;
    return released > 0 ? this.selectedMonth().inventoryRecovered / released : 0;
  });
  readonly inventoryPendingRecovery = computed(
    () => Math.max(0, this.selectedMonth().inventoryReleased - this.selectedMonth().inventoryRecovered),
  );
  readonly stagnantCapitalShare = computed(() => {
    const closing = this.selectedMonth().inventoryClosing;
    return closing > 0 ? this.selectedMonth().stagnantCapital / closing : 0;
  });
  readonly agingCriticalCapital = computed(() => Math.round(this.selectedMonth().stagnantCapital * 0.346));
  readonly agingStaleCapital = computed(() => this.selectedMonth().stagnantCapital - this.agingCriticalCapital());
  readonly agingWatchCapital = computed(() => Math.round(this.selectedMonth().inventoryClosing * 0.242));
  readonly agingFreshCapital = computed(
    () => Math.max(0, this.selectedMonth().inventoryClosing - this.selectedMonth().stagnantCapital - this.agingWatchCapital()),
  );

  readonly chartMax = Math.max(...MONTHS.flatMap((month) => [month.netSales, month.investment, month.netProfit]));
  readonly inventoryChartMax = Math.max(...MONTHS.flatMap((month) => [month.inventoryClosing, month.inventoryReleased]));

  constructor() {
    effect(() => {
      this.activeView.set(this.initialView());
      this.partnerScope.set(this.initialPartnerScope());
    });
  }

  setView(view: AdministrationPrototypeView): void {
    this.activeView.set(view);
  }

  setPartnerScope(scope: PartnerPrototypeScope): void {
    this.partnerScope.set(scope);
  }

  reload(): void {}
  openMovementDialog(): void {}
  openPartnerPayment(_partner: 'socio_blanca' | 'socio_andrea_pepe'): void {}
  openCutDialog(): void {}
  exportMonthlyReport(): void {}
  goToWithdrawalBreakdownPage(): void {}

  setRouteScope(value: unknown): void {
    this.routeScope.set(String(value || 'general'));
  }

  lastUpdatedLabel(): string { return 'Actualizado hoy, 10:42'; }
  periodRangeLabel(): string { return 'Marzo–agosto 2026'; }
  cashAvailable(): number { return 64_820; }
  receivableCapital(): number { return 31_860; }
  courierCash(): number { return 8_650; }
  capitalToInvest(): number { return 22_480; }
  transitCapital(): number { return 19_840; }
  reconciledThisMonth(): number { return this.selectedMonth().collected; }
  stagnantSkuCount(): number { return 14; }
  pendingCollectionCount(): number { return 18; }
  pendingInvestmentCount(): number { return 9; }
  transitOrderCount(): number { return 11; }
  attentionCount(): number { return 4; }
  includedClosuresCount(): number { return 6; }

  onMonthChange(event: Event): void {
    const select = event.target;
    if (select instanceof HTMLSelectElement) this.selectedMonthId.set(select.value);
  }

  moveMonth(direction: -1 | 1): void {
    const currentIndex = MONTHS.findIndex((month) => month.id === this.selectedMonthId());
    const nextIndex = Math.min(MONTHS.length - 1, Math.max(0, currentIndex + direction));
    this.selectedMonthId.set(MONTHS[nextIndex].id);
  }

  isFirstMonth(): boolean {
    return this.selectedMonthId() === MONTHS[0].id;
  }

  isLastMonth(): boolean {
    return this.selectedMonthId() === MONTHS[MONTHS.length - 1].id;
  }

  barHeight(value: number): number {
    return Math.max(4, (value / this.chartMax) * 100);
  }

  inventoryBarHeight(value: number): number {
    return Math.max(4, (value / this.inventoryChartMax) * 100);
  }

  inventoryCapitalShare(value: number): number {
    const closing = this.selectedMonth().inventoryClosing;
    return closing > 0 ? (value / closing) * 100 : 0;
  }

  partnerProgress(withdrawn: number): number {
    const share = this.sharePerPartner();
    if (share <= 0) return 0;
    return Math.min(100, Math.max(0, (withdrawn / share) * 100));
  }

  overallPartnerProgress(withdrawn: number): number {
    const share = this.totalSharePerPartner();
    if (share <= 0) return 0;
    return Math.min(100, Math.max(0, (withdrawn / share) * 100));
  }

  boundedRatio(value: number, total: number): number {
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, value / total));
  }

  monthlyDistributionStatus(month: MonthlyFinanceSnapshot): 'Preliminar' | 'Seguimiento' | 'Cobrado después' | 'Cerrado' {
    if (month.id === MONTHS[MONTHS.length - 1].id) return 'Preliminar';
    if (month.cohortPendingToday > 0 || month.inProcessOrderCount > 0) return 'Seguimiento';
    if (month.cohortCollectedAfterPeriod > 0) return 'Cobrado después';
    return 'Cerrado';
  }

  formatMoney(value: number): string {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 0,
    }).format(value);
  }

  formatPercent(value: number): string {
    return new Intl.NumberFormat('es-MX', {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }

  formatDelta(value: number): string {
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(value)}%`;
  }

  private percentageDelta(current: number, previous: number): number {
    if (previous <= 0) return 0;
    return ((current - previous) / previous) * 100;
  }
}
