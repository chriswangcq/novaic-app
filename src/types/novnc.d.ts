declare module '@novnc/novnc/lib/rfb.js' {
  interface RFBCredentials {
    password?: string;
    username?: string;
    target?: string;
  }

  interface RFBOptions {
    credentials?: RFBCredentials;
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  interface RFBCapabilities {
    power: boolean;
  }

  class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);

    // Properties
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    capabilities: RFBCapabilities;

    // Methods
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;

    // Events (use addEventListener)
    // - 'connect'
    // - 'disconnect' (detail: { clean: boolean })
    // - 'credentialsrequired' (detail: { types: string[] })
    // - 'securityfailure' (detail: { status: number, reason: string })
    // - 'clipboard' (detail: { text: string })
    // - 'bell'
    // - 'desktopname' (detail: { name: string })
    // - 'capabilities' (detail: { capabilities: RFBCapabilities })
  }

  export default RFB;
}
