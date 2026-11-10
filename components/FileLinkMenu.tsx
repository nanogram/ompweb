"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import { AppWindow, Download, PanelRightOpen } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getFileApiUrl } from "@/lib/file-paths";
import { canOpenInSystemApp } from "@/lib/native-file-types";
import { useI18n } from "@/lib/i18n";
import type { WorkspaceFileSource } from "@/lib/workspace-types";
import { toast } from "./ui/toast";

function useNativeFileOpen(filePath: string, hostId: string, sessionId?: string | null) {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const response = await fetch(getFileApiUrl(filePath, "open-native", hostId, sessionId), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
    } catch (error) {
      toast.error(t("fileLink.openFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  };
  return { opening, open };
}

export function NativeFileOpenButton({ filePath, hostId, sourceSessionId }: {
  filePath: string; hostId: string; sourceSessionId?: string | null;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const { opening, open } = useNativeFileOpen(filePath, hostId, sourceSessionId);
  if (isMobile || hostId !== "local" || !canOpenInSystemApp(filePath)) return null;
  return (
    <button
      type="button"
      className="file-viewer-icon-button ui-focus-ring"
      title={t("fileLink.openOnWebComputer")}
      aria-label={t("fileLink.openSystemApp")}
      disabled={opening}
      onClick={() => void open()}
    >
      <AppWindow size={13} aria-hidden="true" />
    </button>
  );
}

/** Only eligible desktop file links replace the browser menu; Shift-right-click keeps it. */
export function FileLinkMenu({ filePath, source, onPreview, children }: {
  filePath: string;
  source: WorkspaceFileSource | null;
  onPreview: () => void;
  children: ReactElement;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const hostId = source?.hostId ?? "local";
  const { opening, open } = useNativeFileOpen(filePath, hostId, source?.sessionId);
  if (isMobile || hostId !== "local" || !canOpenInSystemApp(filePath)) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={children}
        onContextMenu={(event) => { if (event.shiftKey && event.button === 2) event.preventBaseUIHandler(); }}
      />
      <ContextMenu.Portal>
        <ContextMenu.Positioner style={{ zIndex: 1200 }}>
          <ContextMenu.Popup className="file-link-menu" aria-label={t("fileLink.actions")} onClick={(event) => event.stopPropagation()}>
            <ContextMenu.Group>
              <ContextMenu.GroupLabel className="file-link-menu-caption">{t("fileLink.webComputer")}</ContextMenu.GroupLabel>
              <ContextMenu.Item className="file-link-menu-item" disabled={opening} onClick={() => void open()} title={t("fileLink.openOnWebComputer")}>
                <AppWindow size={14} aria-hidden="true" />{t("fileLink.openSystemApp")}
              </ContextMenu.Item>
              <ContextMenu.Item className="file-link-menu-item" onClick={onPreview}>
                <PanelRightOpen size={14} aria-hidden="true" />{t("fileLink.preview")}
              </ContextMenu.Item>
              <ContextMenu.LinkItem className="file-link-menu-item" href={getFileApiUrl(filePath, "download", hostId, source?.sessionId)} download closeOnClick>
                <Download size={14} aria-hidden="true" />{t("fileViewer.downloadFile")}
              </ContextMenu.LinkItem>
            </ContextMenu.Group>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
