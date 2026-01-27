import { Routes } from '@angular/router';
import { adminGuard } from "./core/admin.guard";
export const routes: Routes = [
  {
    path: "login",
    loadComponent: () => import("./features/auth/login/login").then((m) => m.default),
  },
  {
    path: "inbox",
    canActivate: [adminGuard],
    loadComponent: () => import("./features/inbox/inbox").then((m) => m.default),
  },
  {
    path: "review/:id",
    canActivate: [adminGuard],
    loadComponent: () => import("./features/review/review").then((m) => m.default),
  },

  { path: "", pathMatch: "full", redirectTo: "inbox" },
  { path: "**", redirectTo: "inbox" },
];
