import "./boot";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { AppShell } from "@/components/AppShell";
import { IosFocusZoomGuard } from "@/components/IosFocusZoomGuard";
import { LoginForm } from "@/components/LoginForm";
import { RouteLoadingFallback } from "@/components/RouteLoadingFallback";
import { createComposerHmrPreservation, serializeCssHmrUpdates } from "@/lib/ui-customization-client";

// Module-scoped, not an effect: StrictMode's mount replay is not an HMR signal.
// No accept/data boundary; Bun's React Fast Refresh owns hot replacement.
if (process.env.OMP_WEB_PUBLIC_UI_CUSTOMIZATION === "1" && import.meta.hot) {
  const restoreCssReplace = serializeCssHmrUpdates();
  const composer = createComposerHmrPreservation();
  import.meta.hot.on("bun:beforeUpdate", composer.beforeUpdate);
  import.meta.hot.on("bun:afterUpdate", composer.afterUpdate);
  import.meta.hot.on("bun:beforeFullReload", composer.cancel);
  import.meta.hot.on("bun:error", composer.cancel);
  import.meta.hot.dispose(() => { composer.cancel(); restoreCssReplace(); });
}

// createRoot (not hydrateRoot) replaces the static skeleton or sign-in form that app/index.html puts in #root; a
// password typed into the static form carries over.
const typedPassword = document.querySelector<HTMLInputElement>("#root #web-password")?.value;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <IosFocusZoomGuard />
      {location.pathname === "/login" ? (
        <LoginForm initialPassword={typedPassword} />
      ) : (
        <Suspense fallback={<RouteLoadingFallback />}>
          <AppShell appName={document.title} />
        </Suspense>
      )}
    </AppErrorBoundary>
  </StrictMode>,
);
