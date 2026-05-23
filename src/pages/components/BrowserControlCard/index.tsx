import { Alert, Button, Card, Input, Space, Typography } from "@arco-design/web-react";
import { useEffect, useMemo, useState } from "react";
import {
  browserIdentityFromUserAgent,
  clearBrowserControlIdentityOverride,
  getBrowserControlIdentityOverride,
  setBrowserControlIdentityOverride,
  type BrowserControlIdentityOverride,
} from "@App/pkg/browser-control/identity";

type NativeMessagingStatus = "connected" | "connecting" | "disconnected" | "error";

type NativeMessagingStatusResponse = {
  status: NativeMessagingStatus;
  hostName: string;
  lastError?: string;
};

const emptyOverride: BrowserControlIdentityOverride = {};

function getNativeStatus(): Promise<NativeMessagingStatusResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "nativeMessaging.GET_STATUS" }, (resp: NativeMessagingStatusResponse) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({
          status: "error",
          hostName: "com.latentbyte.browser_control",
          lastError: lastError.message,
        });
        return;
      }
      resolve(resp);
    });
  });
}

function BrowserControlCard() {
  const detected = useMemo(() => browserIdentityFromUserAgent(), []);
  const [override, setOverride] = useState<BrowserControlIdentityOverride>(emptyOverride);
  const [status, setStatus] = useState<NativeMessagingStatusResponse | null>(null);
  const [savedLabel, setSavedLabel] = useState("");

  useEffect(() => {
    let mounted = true;
    void getBrowserControlIdentityOverride().then((value) => {
      if (mounted) setOverride(value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void getNativeStatus().then((value) => {
        if (mounted) setStatus(value);
      });
    };
    refresh();
    const intervalId = window.setInterval(refresh, 2000);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeIdentity = {
    browserName: override.browserName || detected.browserName,
    appName: override.appName || detected.appName,
  };

  const save = async () => {
    await setBrowserControlIdentityOverride(override);
    setSavedLabel("Saved");
    window.setTimeout(() => setSavedLabel(""), 1200);
  };

  const reset = async () => {
    await clearBrowserControlIdentityOverride();
    setOverride(emptyOverride);
    setSavedLabel("Reset");
    window.setTimeout(() => setSavedLabel(""), 1200);
  };

  return (
    <Card
      size="small"
      title="Browser Control"
      style={{ marginBottom: 8 }}
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {"Status: "}
        {status ? `${status.status} (${status.hostName})` : "checking"}
      </Typography.Text>
      {status?.lastError && <Alert type="warning" content={status.lastError} />}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {`Sending: ${activeIdentity.browserName} / ${activeIdentity.appName}`}
      </Typography.Text>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Input
          size="small"
          placeholder={`browser name, detected ${detected.browserName}`}
          value={override.browserName || ""}
          onChange={(value) => setOverride((prev) => ({ ...prev, browserName: value }))}
        />
        <Input
          size="small"
          placeholder={`app name, detected ${detected.appName}`}
          value={override.appName || ""}
          onChange={(value) => setOverride((prev) => ({ ...prev, appName: value }))}
        />
      </Space>
      <Space>
        <Button size="small" type="primary" onClick={save}>
          {"Save"}
        </Button>
        <Button size="small" onClick={reset}>
          {"Reset"}
        </Button>
        {savedLabel && <Typography.Text type="secondary">{savedLabel}</Typography.Text>}
      </Space>
    </Card>
  );
}

export default BrowserControlCard;
