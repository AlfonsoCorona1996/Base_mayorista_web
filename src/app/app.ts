import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { firebaseSmokeTest } from "./core/firebase.smoketest";

@Component({
  selector: 'app-root',
   standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  constructor() {
    firebaseSmokeTest();
  }
  protected readonly title = signal('admin-web');
}
