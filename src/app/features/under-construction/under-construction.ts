import { Component, inject } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";

@Component({
  standalone: true,
  selector: "app-under-construction",
  imports: [RouterLink],
  templateUrl: "./under-construction.html",
  styleUrl: "./under-construction.css",
})
export default class UnderConstructionPage {
  private route = inject(ActivatedRoute);

  title = (this.route.snapshot.data["title"] as string) || "Modulo en construccion";
  description =
    (this.route.snapshot.data["description"] as string) ||
    "Estamos preparando este modulo para la siguiente iteracion.";
}
