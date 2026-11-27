import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {productionBrowserPolicy} from "../shared/browserPolicy";
export default defineConfig({
  root:"counter-app",envDir:"..",base:"/People-Counter-System/",
  plugins:[react(),productionBrowserPolicy()],
  build:{rollupOptions:{input:{counterManagement:"counter-app/counter-management/index.html",counterSync:"counter-app/src/counterSync.ts"},output:{entryFileNames:entry=>entry.name==="counterSync"?"people-counter/counter-sync.js":"counter-management/app-[hash].js"}}}
});
