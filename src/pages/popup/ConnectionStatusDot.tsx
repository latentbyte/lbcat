import type { NativeMessagingStatusResponse } from "@App/pages/components/PopupWarnings";
import { Badge, Tooltip } from "@arco-design/web-react";

interface ConnectionStatusDotProps {
  status: NativeMessagingStatusResponse;
}

const badgeStatusByConnection = {
  connected: "success",
  connecting: "warning",
  disconnected: "error",
  error: "error",
} as const;

function ConnectionStatusDot({ status }: ConnectionStatusDotProps) {
  const label = `Browser Control: ${status.status}${status.lastError ? ` (${status.lastError})` : ""}`;

  return (
    <Tooltip content={label}>
      <span role="status" aria-label={label} data-connection-status={status.status} className="connection-status-dot">
        <Badge dot status={badgeStatusByConnection[status.status]} />
      </span>
    </Tooltip>
  );
}

export default ConnectionStatusDot;
