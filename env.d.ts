/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

declare module "vite/client" {
  interface ImportMetaEnv {
    readonly VITE_APP_TITLE: string
    // ajoute tes variables d'env ici si besoin
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}