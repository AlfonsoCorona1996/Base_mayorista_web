import { CurrencyPipe, DatePipe, PercentPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { Customer, CustomersService } from "../../core/customers.service";
import { FinanceExpense, FinanceService } from "../../core/finance.service";
import { LocalitiesService } from "../../core/localities.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { Order } from "../../core/orders.service";
import { OrdersService } from "../../core/orders.service";
import { RoutePlan, RoutesService } from "../../core/routes.service";
import { RouteRunDoc, RouteRunsService } from "../../services/route-runs.service";

type RouteTab = "summary" | "runs" | "orders" | "customers" | "expenses" | "localities";

interface RouteSummary {
  netSales: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  margin: number;
  balanceDue: number;
  returnsAmount: number;
  pendingOrders: number;
  investmentNeeded: number;
}

interface RunInsight {
  run: RouteRunDoc;
  ordersCount: number;
  saleTotal: number;
  cost: number;
  grossProfit: number;
  expense: number;
  expenseSource: "real" | "estimated" | "none";
  netProfit: number;
  packages: number;
  balanceDue: number;
}

interface CustomerInsight {
  customer: Customer;
  orders: number;
  netSales: number;
  ticket: number;
  balanceDue: number;
  lastOrder: string | null;
}

interface PendingOrderInsight {
  order: Order;
  customerName: string;
  sale: number;
  cost: number;
  grossProfit: number;
  balanceDue: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-ruta-detalle",
  imports: [RouterLink, CurrencyPipe, DatePipe, PercentPipe],
  templateUrl: "./ruta-detalle.html",
  styleUrl: "./ruta-detalle.css",
})
export default class RutaDetallePage {
  private activatedRoute = inject(ActivatedRoute);
  private router = inject(Router);
  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);
  private customersService = inject(CustomersService);
  private ordersService = inject(OrdersService);
  private financeService = inject(FinanceService);
  private routeRuns = inject(RouteRunsService);

  routeId = signal(this.activatedRoute.snapshot.paramMap.get("id") || "");
  loading = signal(false);
  error = signal<string | null>(null);
  financeAvailable = signal(true);
  activeTab = signal<RouteTab>("summary");
  runs = signal<RouteRunDoc[]>([]);

  routePlan = computed(() => this.routesService.getById(this.routeId()));
  localities = computed(() => this.localitiesService.localities());
  customers = computed(() => this.customersService.customers());
  orders = computed(() => this.ordersService.list());
  expenses = computed(() => this.financeService.expenses());

  routeOrders = computed(() => this.orders().filter((order) => order.route_id === this.routeId()));
  routeCustomers = computed(() => this.customers().filter((customer) => customer.route_id === this.routeId()));
  routeExpenses = computed(() => this.financeAvailable() ? this.expenses().filter((row) => row.route_id === this.routeId()) : []);
  routeRunsForRoute = computed(() => this.runs().filter((run) => run.route_id === this.routeId()).sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at)));
  pendingOrders = computed<PendingOrderInsight[]>(() => this.buildPendingOrders());
  runInsights = computed<RunInsight[]>(() => this.buildRunInsights());
  customerInsights = computed<CustomerInsight[]>(() => this.buildCustomerInsights());
  summary = computed<RouteSummary>(() => this.buildSummary());

  tabs: Array<{ key: RouteTab; label: string; icon: string }> = [
    { key: "summary", label: "Resumen", icon: "dashboard" },
    { key: "runs", label: "Salidas", icon: "local_shipping" },
    { key: "orders", label: "Pedidos", icon: "receipt_long" },
    { key: "customers", label: "Clientas", icon: "groups" },
    { key: "expenses", label: "Gastos", icon: "local_gas_station" },
    { key: "localities", label: "Localidades", icon: "location_on" },
  ];

  constructor() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    try {
      await Promise.all([
        this.routesService.loadFromFirestore(),
        this.localitiesService.loadFromFirestore(),
        this.customersService.loadFromFirestore(),
        this.ordersService.loadFromFirestore(),
      ]);
      const financeLoaded = await this.financeService.loadAll().then(() => true).catch(() => false);
      this.financeAvailable.set(financeLoaded);
      this.runs.set(await this.routeRuns.listRuns().catch(() => []));
      if (!this.routePlan()) this.error.set("No se encontró la ruta solicitada");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar la ruta");
    } finally {
      this.loading.set(false);
    }
  }

  setTab(tab: RouteTab) {
    this.activeTab.set(tab);
  }

  goBack() {
    this.router.navigateByUrl("/main/rutas");
  }

  localityName(localityId: string): string {
    return this.localitiesService.getById(localityId)?.name || localityId;
  }

  localityCustomerCount(localityId: string): number {
    return this.routeCustomers().filter((customer) => customer.locality_id === localityId).length;
  }

  customerName(customerId: string): string {
    const customer = this.customersService.getById(customerId);
    return customer ? `${customer.first_name} ${customer.last_name}`.trim() : customerId || "Clienta";
  }

  runStatusLabel(status: string): string {
    return ({ draft: "Borrador", scheduled: "Programada", in_transit: "En ruta", completed: "Completada", cancelled: "Cancelada" } as Record<string, string>)[status] || status;
  }

  orderStatusLabel(status: string): string {
    return ({
      ready_for_route: "Lista para salir",
      assigned_to_run: "Asignada",
      packing: "Empaque",
      empaque: "Empaque",
      delivered: "Entregada",
      delivered_partial: "Parcial",
      pagado: "Pagada",
      pagado_parcial: "Pago parcial",
      pago_pendiente: "Pago pendiente",
    } as Record<string, string>)[status] || status;
  }

  expenseSourceLabel(source: RunInsight["expenseSource"]): string {
    if (source === "real") return "Real";
    if (source === "estimated") return "Estimado";
    return "Sin gasto";
  }

  private buildSummary(): RouteSummary {
    const route = this.routePlan();
    const delivered = this.routeOrders().filter((order) => this.isDelivered(order));
    let netSales = 0;
    let grossProfit = 0;
    let returnsAmount = 0;
    let balanceDue = 0;
    for (const order of this.routeOrders().filter((row) => !this.isCancelled(row))) {
      balanceDue += calculateOrderFinancials(order).balanceDue;
    }
    for (const order of delivered) {
      const financials = calculateOrderFinancials(order);
      netSales += financials.netAmount;
      grossProfit += financials.grossProfit;
      returnsAmount += financials.returnsAmount;
    }
    const expenses = this.routeExpenses().reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
    const pendingCost = this.pendingOrders().reduce((sum, row) => sum + row.cost, 0);
    const estimatedExpense = this.pendingOrders().length > 0 ? Number(route?.estimated_run_expense || 0) : 0;
    return {
      netSales,
      grossProfit,
      expenses,
      netProfit: grossProfit - expenses,
      margin: netSales > 0 ? grossProfit / netSales : 0,
      balanceDue,
      returnsAmount,
      pendingOrders: this.pendingOrders().length,
      investmentNeeded: pendingCost + estimatedExpense,
    };
  }

  private buildRunInsights(): RunInsight[] {
    const route = this.routePlan();
    return this.routeRunsForRoute().map((run) => {
      const orders = this.routeOrders().filter((order) => order.route_run_id === run.runId);
      let saleTotal = 0;
      let cost = 0;
      let grossProfit = 0;
      let balanceDue = 0;
      for (const order of orders) {
        const financials = calculateOrderFinancials(order);
        saleTotal += financials.netAmount;
        cost += financials.netCost;
        grossProfit += financials.grossProfit;
        balanceDue += financials.balanceDue;
      }
      const realExpense = this.routeExpenses()
        .filter((expense) => expense.route_run_id === run.runId)
        .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
      const estimatedExpense = realExpense <= 0 ? Number(route?.estimated_run_expense || 0) : 0;
      const expense = realExpense || estimatedExpense;
      return {
        run,
        ordersCount: orders.length || run.counts.orders_total,
        saleTotal,
        cost,
        grossProfit,
        expense,
        expenseSource: realExpense > 0 ? "real" : estimatedExpense > 0 ? "estimated" : "none",
        netProfit: grossProfit - expense,
        packages: orders.reduce((sum, order) => sum + Math.max(0, Number(order.packing?.packages_count || 0)), 0) || run.counts.packages_total,
        balanceDue: balanceDue || run.counts.balance_total,
      };
    });
  }

  private buildPendingOrders(): PendingOrderInsight[] {
    return this.routeOrders()
      .filter((order) => !order.route_run_id && !this.isCancelled(order) && (order.status === "ready_for_route" || order.packing?.status === "done" || order.dispatch_request?.status === "requested"))
      .map((order) => {
        const financials = calculateOrderFinancials(order);
        return {
          order,
          customerName: this.customerName(order.customer_id),
          sale: financials.netAmount,
          cost: financials.netCost,
          grossProfit: financials.grossProfit,
          balanceDue: financials.balanceDue,
        };
      })
      .sort((a, b) => b.sale - a.sale);
  }

  private buildCustomerInsights(): CustomerInsight[] {
    return this.routeCustomers()
      .map((customer) => {
        const orders = this.routeOrders().filter((order) => order.customer_id === customer.customer_id && !this.isCancelled(order));
        const delivered = orders.filter((order) => this.isDelivered(order));
        let netSales = 0;
        let balanceDue = 0;
        for (const order of orders) balanceDue += calculateOrderFinancials(order).balanceDue;
        for (const order of delivered) netSales += calculateOrderFinancials(order).netAmount;
        const orderDates = delivered
          .map((order) => order.delivered_at || order.updated_at || order.created_at)
          .filter(Boolean)
          .sort();
        const lastOrder = orderDates.length ? orderDates[orderDates.length - 1] : null;
        return {
          customer,
          orders: delivered.length,
          netSales,
          ticket: delivered.length ? netSales / delivered.length : 0,
          balanceDue,
          lastOrder,
        };
      })
      .sort((a, b) => b.netSales - a.netSales);
  }

  private isCancelled(order: Order): boolean {
    return ["cancelado", "devuelto"].includes(String(order.status || ""));
  }

  private isDelivered(order: Order): boolean {
    return Boolean(order.delivered_at) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"].includes(String(order.status || ""));
  }
}
