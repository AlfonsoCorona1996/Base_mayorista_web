import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpParams } from "@angular/common/http";
import { environment } from "../../../../environments/environment";

export type TrackTone = "neutral" | "info" | "warning" | "success" | "danger";

export interface TrackStatus {
  key: string;
  label: string;
  tone: TrackTone;
}

export interface TrackSupport {
  whatsapp_number: string;
  whatsapp_display: string;
}

export interface TrackOrderTotals {
  customer_total: number;
  paid_amount: number;
  balance_due: number;
  estimated_profit: number;
  estimated_profit_complete: boolean;
}

export interface TrackOrderSummary {
  order_id: string;
  status: TrackStatus;
  created_at: string | null;
  updated_at: string | null;
  items_count: number;
  units_count: number;
  returned_units: number;
  totals: TrackOrderTotals;
}

export interface TrackReturn {
  return_id: string;
  order_id: string;
  product: { title: string; variant: string | null; color: string | null };
  quantity: number;
  status: TrackStatus;
  resolution: { key: string; label: string; amount: number };
  created_at: string | null;
  updated_at: string | null;
}

export interface TrackPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface TrackDashboard {
  customer: { first_name: string };
  support: TrackSupport;
  summary: {
    estimated_profit: number;
    estimated_profit_complete: boolean;
    incomplete_profit_orders: number;
    total_due: number;
    credit_balance: number;
    active_orders: number;
    completed_orders: number;
    returns_count: number;
  };
  active_orders: TrackOrderSummary[];
  history: TrackPage<TrackOrderSummary>;
  returns: TrackPage<TrackReturn>;
  generated_at: string;
}

export interface TrackProgressStage {
  key: string;
  label: string;
  date: string | null;
  state: "complete" | "current" | "pending" | "problem";
}

export interface TrackOrderItem {
  title: string;
  variant: string | null;
  color: string | null;
  image_url: string | null;
  ordered_quantity: number;
  confirmed_quantity: number;
  returned_quantity: number;
  net_quantity: number;
  confirmation: TrackStatus;
  customer_unit_price: number;
  public_unit_price: number | null;
  customer_line_total: number;
  estimated_profit: number | null;
}

export interface TrackOrderDetail extends TrackOrderSummary {
  progress: TrackProgressStage[];
  items: TrackOrderItem[];
  account: {
    total: number;
    paid: number;
    pending: number;
    returns_credit: number;
  };
  returns: TrackReturn[];
}

export interface TrackOrderDetailResponse {
  customer: { first_name: string };
  support: TrackSupport;
  order: TrackOrderDetail;
  generated_at: string;
}

@Injectable({ providedIn: "root" })
export class TrackingPortalService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.adminApiBaseUrl.replace(/\/+$/, "");

  loadDashboard(token: string) {
    return this.http.get<TrackDashboard>(`${this.baseUrl}/api/track/${encodeURIComponent(token)}`);
  }

  loadHistory(token: string, cursor: string) {
    const params = new HttpParams().set("cursor", cursor).set("limit", 10);
    return this.http.get<TrackPage<TrackOrderSummary>>(
      `${this.baseUrl}/api/track/${encodeURIComponent(token)}/history`,
      { params },
    );
  }

  loadReturns(token: string, cursor: string) {
    const params = new HttpParams().set("cursor", cursor).set("limit", 10);
    return this.http.get<TrackPage<TrackReturn>>(
      `${this.baseUrl}/api/track/${encodeURIComponent(token)}/returns`,
      { params },
    );
  }

  loadOrder(token: string, orderId: string) {
    return this.http.get<TrackOrderDetailResponse>(
      `${this.baseUrl}/api/track/${encodeURIComponent(token)}/orders/${encodeURIComponent(orderId)}`,
    );
  }
}
