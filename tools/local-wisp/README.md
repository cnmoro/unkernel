# Unkernel Local Wisp

Run the relay on your computer to use your own internet connection from the browser VM. The relay opens a local status page with the address to enter in Unkernel.

1. Download and extract the package for your operating system and CPU. Choose `amd64` for Intel or AMD, or `arm64` for Apple Silicon and other 64-bit ARM PCs.
2. On Windows, double-click **Unkernel Local Wisp.exe**. On macOS, open **Unkernel Local Wisp.app**. On Linux, open `unkernel-local-wisp` from your file manager or run `./unkernel-local-wisp` from a terminal. The binaries are unsigned, so your operating system may require you to approve the first launch.
3. At [linux.kinetiq.com.br](https://linux.kinetiq.com.br), open **System → Network → Wisp, custom servers**. Enter `ws://127.0.0.1:8765/wisp/` as the only URL. Click **Test local relay** if available and allow loopback access when Chrome asks. Choose **Reboot to apply**.
4. Keep the relay running while using the VM. Choose **Stop relay** on its local status page to exit.

Use current Chrome or a compatible Chromium browser. Chrome allows loopback WebSockets from HTTPS pages with the site's loopback permission. If you denied the prompt, change the site's Loopback network permission in browser settings and test again. [Chrome's Local Network Access guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)

The relay listens on IPv4 loopback only. Its default allowed browser origin is `https://linux.kinetiq.com.br`. It forwards TCP to public IPv4 destinations. Browser VM downloads use your computer's internet connection.

## Optional local HTTPS and WSS

Start the executable with `-tls`. It creates a self-signed local CA and a server certificate limited to `localhost` and `127.0.0.1`. It prints the path to `local-ca.crt` in the current user's configuration directory. To use WSS in your browser, import that certificate into the trust store used by the browser. Use `wss://127.0.0.1:8765/wisp/` and approve loopback access if prompted. The app generates its own keys on each computer and sets up trust only when you import the certificate.

```sh
./unkernel-local-wisp -tls
```

On Windows, run `& ".\Unkernel Local Wisp.exe" -tls` in PowerShell. On macOS, run `open "Unkernel Local Wisp.app" --args -tls` with the app stopped, or invoke its executable under `Contents/MacOS/` to see the certificate path. On certificate expiry, stop the relay and remove its `server.pem` file, then start it with `-tls` and trust the regenerated certificate.

Optional flags include `-port 8766` for a different port, `-origin https://your-site.example` for your own Unkernel deployment, and `-no-open` for use from a terminal without opening the status page.

## Build from source

Use Go 1.26 or newer. From `tools/local-wisp`, run `go build .` to build for your computer, or `python3 package.py /path/to/output` to create all six release archives and SHA-256 checksums.
