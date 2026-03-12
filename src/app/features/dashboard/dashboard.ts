import { Component, ChangeDetectionStrategy } from "@angular/core";
import { RouterLink } from "@angular/router";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-dashboard",
  imports: [RouterLink],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.css",
})
export default class DashboardPage {}
