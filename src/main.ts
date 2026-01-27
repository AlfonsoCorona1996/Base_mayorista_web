import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { provideRouter } from "@angular/router";
import { routes } from "./app/app.routes";
import { provideFirebaseCore } from "./app/core/firebase.providers";

bootstrapApplication(App, {
  providers: [
    provideRouter(routes),
    provideFirebaseCore(),
  ],
}).catch((err) => console.error(err));
