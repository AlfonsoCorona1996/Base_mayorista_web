import { bootstrapApplication } from "@angular/platform-browser";
import { appConfig } from "./app/app.config";
import { App } from "./app/app";
import { provideFirebaseCore } from "./app/core/firebase.providers";

bootstrapApplication(App, {
  providers: [
    ...appConfig.providers,
    provideFirebaseCore(),
  ],
}).catch((err) => console.error(err));
