# The VPN

Pick a country in the menu bar (or on Today) and the whole Mac exits there. Turn it off and it
costs nothing.

## How it works

Picking a country starts a throwaway server in Google Cloud in that region: a spot `e2-micro`
that deletes itself after ten hours at most. The app points your VPN hostname at it through
Cloudflare's API and starts a WireGuard tunnel. Every server gets the same WireGuard keys
through instance metadata, so the one tunnel you import works with any country; only the address
behind the hostname changes. Private ranges stay off the tunnel, so the local network keeps
working. Turning it off stops the tunnel and deletes the server.

## What you need

1. A Google Cloud project with Compute Engine enabled, and the `gcloud` CLI signed in
   (Homebrew's `gcloud` at `/opt/homebrew/bin` or `/usr/local/bin`).
2. A domain on Cloudflare and an API token that can edit its DNS, saved (one line) at
   `~/.config/cloudflare/api-token`.
3. The WireGuard app from the Mac App Store.
4. A config file at
   `~/Library/Application Support/com.gusdantas.assistant/vpn/config.json`:

   ```json
   {
     "gcp_project": "your-project-id",
     "host": "vpn.example.com",
     "cloudflare_zone": "your-cloudflare-zone-id"
   }
   ```

The first time, the app writes the keys next to that file and leaves `GusVPN.conf` selected in
Finder: import it into WireGuard once, then pick the country again.
