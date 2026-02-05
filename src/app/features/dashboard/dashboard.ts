import { Component } from "@angular/core";
import { RouterLink } from "@angular/router";

@Component({
  standalone: true,
  selector: "app-dashboard",
  imports: [RouterLink],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.css",
})
export default class DashboardPage {}
