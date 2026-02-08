import { Routes } from '@angular/router';
import { adminGuard } from "./core/admin.guard";
export const routes: Routes = [
  {
    path: "login",
    loadComponent: () => import("./features/auth/login/login").then((m) => m.default),
  },
  {
    path: "main",
    canActivate: [adminGuard],
    loadComponent: () => import("./features/main/main-layout").then((m) => m.default),
    children: [
      {
        path: "dashboard",
        loadComponent: () => import("./features/dashboard/dashboard").then((m) => m.default),
      },
      {
        path: "validacion",
        loadComponent: () => import("./features/inbox/inbox").then((m) => m.default),
      },
      {
        path: "catalogo/:id",
        loadComponent: () => import("./features/catalog/catalog-detail").then((m) => m.default),
      },
      {
        path: "catalogo",
        loadComponent: () => import("./features/catalog/catalog").then((m) => m.default),
      },
      {
        path: "inventario",
        loadComponent: () => import("./features/inventario/inventario").then((m) => m.default),
      },
      {
        path: "clientas",
        loadComponent: () => import("./features/clientas/clientas").then((m) => m.default),
      },
      {
        path: "rutas",
        loadComponent: () => import("./features/rutas/rutas").then((m) => m.default),
      },
      {
        path: "localidades",
        loadComponent: () => import("./features/localidades/localidades").then((m) => m.default),
      },
      {
        path: "edicion-productos",
        data: {
          title: "Edicion de productos",
          description: "Pantalla en construccion para editar catalogo publicado.",
        },
        loadComponent: () =>
          import("./features/under-construction/under-construction").then((m) => m.default),
      },
      {
        path: "proveedores",
        loadComponent: () => import("./features/proveedores/proveedores").then((m) => m.default),
      },
      {
        path: "categorias",
        loadComponent: () => import("./features/categorias/categorias").then((m) => m.default),
      },
      {
        path: "pedidos",
        loadComponent: () => import("./features/pedidos/pedidos").then((m) => m.default),
      },
      {
        path: "pedidos/:id",
        loadComponent: () => import("./features/pedidos/pedido-detalle").then((m) => m.default),
      },
      {
        path: "review/:id",
        loadComponent: () => import("./features/review/review").then((m) => m.default),
      },
      { path: "inbox", pathMatch: "full", redirectTo: "validacion" },
      { path: "", pathMatch: "full", redirectTo: "dashboard" },
    ],
  },

  // Compatibilidad con rutas antiguas
  { path: "inbox", pathMatch: "full", redirectTo: "main/validacion" },
  { path: "validacion", pathMatch: "full", redirectTo: "main/validacion" },
  { path: "review/:id", redirectTo: "main/review/:id" },

  { path: "", pathMatch: "full", redirectTo: "main/dashboard" },
  { path: "**", redirectTo: "main/dashboard" },
];
