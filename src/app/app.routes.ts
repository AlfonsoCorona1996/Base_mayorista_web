import { Routes, UrlMatcher } from '@angular/router';
import { adminGuard } from "./core/admin.guard";
import { permissionGuard } from "./core/permission.guard";
import { authzGuard } from "./core/authz.guard";

const loginMatcher: UrlMatcher = (segments) => {
  if (!segments.length) return null;
  if (segments[0].path.toLowerCase() !== "login") return null;
  return { consumed: segments };
};

export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    loadComponent: () => import("./features/public/public-home").then((m) => m.default),
  },
  {
    matcher: loginMatcher,
    loadComponent: () => import("./features/auth/login/login").then((m) => m.default),
  },
  {
    path: "activate-account",
    loadComponent: () => import("./features/auth/activate-account/activate-account").then((m) => m.default),
  },
  {
    path: "main",
    canActivate: [adminGuard],
    loadComponent: () => import("./features/main/main-layout").then((m) => m.default),
    children: [
      {
        path: "dashboard",
        canActivate: [permissionGuard],
        data: { permission: "dashboard" },
        loadComponent: () => import("./features/dashboard/dashboard").then((m) => m.default),
      },
      {
        path: "validacion",
        canActivate: [permissionGuard],
        data: { permission: "validacion" },
        loadComponent: () => import("./features/inbox/inbox").then((m) => m.default),
      },
      {
        path: "catalogo/:id",
        canActivate: [permissionGuard],
        data: { permission: "catalogo" },
        loadComponent: () => import("./features/catalog/catalog-detail").then((m) => m.default),
      },
      {
        path: "catalogo",
        canActivate: [permissionGuard],
        data: { permission: "catalogo" },
        loadComponent: () => import("./features/catalog/catalog").then((m) => m.default),
      },
      {
        path: "inventario",
        canActivate: [permissionGuard],
        data: { permission: "inventario" },
        loadComponent: () => import("./features/inventario/inventario").then((m) => m.default),
      },
      {
        path: "clientas",
        canActivate: [permissionGuard],
        data: { permission: "clientas" },
        loadComponent: () => import("./features/clientas/clientas").then((m) => m.default),
      },
      {
        path: "rutas",
        canActivate: [permissionGuard],
        data: { permission: "rutas" },
        loadComponent: () => import("./features/rutas/rutas").then((m) => m.default),
      },
      {
        path: "localidades",
        canActivate: [permissionGuard],
        data: { permission: "localidades" },
        loadComponent: () => import("./features/localidades/localidades").then((m) => m.default),
      },
      {
        path: "edicion-productos",
        canActivate: [permissionGuard],
        data: {
          permission: "edicion_productos",
          title: "Edicion de productos",
          description: "Pantalla en construccion para editar catalogo publicado.",
        },
        loadComponent: () =>
          import("./features/under-construction/under-construction").then((m) => m.default),
      },
      {
        path: "proveedores",
        canActivate: [permissionGuard],
        data: { permission: "proveedores" },
        loadComponent: () => import("./features/proveedores/proveedores").then((m) => m.default),
      },
      {
        path: "categorias",
        canActivate: [permissionGuard],
        data: { permission: "categorias" },
        loadComponent: () => import("./features/categorias/categorias").then((m) => m.default),
      },
      {
        path: "pedidos",
        canActivate: [permissionGuard],
        data: { permission: "pedidos" },
        loadComponent: () => import("./features/pedidos/pedidos").then((m) => m.default),
      },
      {
        path: "pedidos/:id",
        canActivate: [permissionGuard],
        data: { permission: "pedidos" },
        loadComponent: () => import("./features/pedidos/pedido-detalle").then((m) => m.default),
      },
      {
        path: "salidas",
        canActivate: [authzGuard],
        data: { section: "sections.salidas" },
        loadComponent: () => import("./features/salidas/salidas.page").then((m) => m.default),
      },
      {
        path: "salidas/:runId",
        canActivate: [authzGuard],
        data: { section: "sections.salidas" },
        loadComponent: () => import("./features/salidas/salida-detalle.page").then((m) => m.default),
      },
      {
        path: "administracion",
        canActivate: [authzGuard],
        data: { section: "sections.administracion" },
        loadComponent: () => import("./features/administracion/administracion").then((m) => m.default),
      },
      {
        path: "proveedores-operaciones",
        canActivate: [permissionGuard],
        data: { permission: "pedidos" },
        loadComponent: () =>
          import("./features/proveedores-operaciones/proveedores-operaciones").then((m) => m.default),
      },
      {
        path: "usuarios",
        canActivate: [authzGuard],
        data: { section: "sections.usuarios" },
        loadComponent: () => import("./features/usuarios/usuarios").then((m) => m.default),
      },
      {
        path: "review/:id",
        canActivate: [permissionGuard],
        data: { permission: "validacion" },
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
  { path: "**", redirectTo: "" },
];
