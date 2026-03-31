import { ChangeDetectionStrategy, Component } from "@angular/core";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-privacy-page",
  templateUrl: "./privacy.html",
  styleUrl: "./privacy.css",
})
export default class PrivacyPage {}

