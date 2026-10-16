# Homebridge ORVIBO Cloud


Connect ORVIBO HomeMate devices directly to Apple Home through Homebridge.
This is a standalone Node.js port of the supplied `orvibo_cloud` Home Assistant
integration **1.1.0**. Home Assistant, Python, an ORVIBO developer account and
additional runtime npm dependencies are not required.

## Install

Requires **Node.js 22.12+ (22.x) or 24.x** and **Homebridge 1.8+ or 2.x**.

1. Extract `homebridge-orvibo-cloud-1.0.0.zip` and copy the included
   `homebridge-orvibo-cloud-1.0.0.tgz` to your Homebridge machine.
2. In the directory containing that `.tgz`, run:

   ```bash
   sudo npm install -g ./homebridge-orvibo-cloud-1.0.0.tgz
   ```

3. Restart Homebridge. Open **Plugins → Homebridge ORVIBO Cloud → Settings**.
4. Enter your existing HomeMate username/email/phone number and password.
   Select the **same server used by your working Home Assistant integration**.
   `homemate.orvibo.com` is the default.
5. Save and restart Homebridge. Supported devices appear on the Homebridge
   bridge already paired with Apple Home. A separately configured child bridge
   must be paired using its own QR code.

The package is supplied as a local release; it has not been published to npm.
Run installation in the same Node/npm environment that runs Homebridge. For
Docker or appliance installs, use that installation's persistent plugin location
instead of installing on the host outside the container.

You can also add this object to the existing `platforms` array in Homebridge's
`config.json` (usually `/var/lib/homebridge/config.json` on your Ubuntu install):

```json
{
  "platform": "OrviboCloud",
  "name": "ORVIBO Cloud",
  "username": "your-home-mate-email-or-phone",
  "password": "your-home-mate-password",
  "host": "homemate.orvibo.com",
  "pollInterval": 60,
  "pushUpdates": true,
  "tvProfile": "stored"
}
```

Do not replace the rest of your Homebridge configuration with this object.

## Supported devices

Support follows the verified profiles in the uploaded integration. Discovery
does not imply that every ORVIBO device type can be controlled.

| Source device/profile | Apple Home representation | Controls and feedback |
| --- | --- | --- |
| Type 34 percentage curtain, without an Allone RF hub | Window covering and a Stop switch | 0–100% position, open, close, stop |
| Type 34 RF blind sharing the UID of a type 30/67 Allone hub | Open, Close and Stop momentary switches | Exact RF button commands; no invented position |
| Type 1/102, subtype 1 relay light | Lightbulb; optionally Switch or Outlet | On/off, with active-low state conversion |
| Type 38, subtype 4/6/13, with valid brightness and temperature state | Lightbulb | On/off, brightness, 2700–6500 K color temperature |
| Type 503, subtype 436, one of the three verified models | Lightbulb | Property-based power, brightness and color temperature |
| Type 6 TV sharing a type 67 Allone Pro UID | One accessory with momentary switches | HomeMate stored keys or standard LG infrared keys |
| `door_status` property | Contact sensor | Open/closed; polling and push events |
| `battery_power` property | Battery service | Percentage and a low-battery flag at 20% or below |

Verified type-503 model IDs:

- `294339fdc9b04613bb6cf1569305b78c`
- `71b94d0309094d1e9c678e4c21bbf878`
- `f731c19a484c419282051494ceecd66a`

Battery-only devices may show in an accessory's details rather than as a
standalone tile in Apple Home. This release does not implement unlocking,
thermostats/air conditioners, scenes, RGB controls or arbitrary unsupported
device commands; those controls are absent from the supplied integration.

RF blinds do not report percentages. TVs have a **power toggle**, with no
confirmed on/off state. Their momentary switches transmit once and reset after
about 0.4 seconds. A rejected or timed-out command is not retried automatically.
Percentage curtain positions and light changes are optimistic after a successful
acknowledgement until a measured cloud report replaces them.

## TV setup

Use `"tvProfile": "stored"` to send the TV buttons saved in HomeMate. This is
the default and does not assume a TV brand. Use `"tvProfile": "lg"` for the
standard LG NEC signals included in the source integration. LG mode also enables
Home, Back and Exit. It is not a general-purpose profile for other brands.

The main controls are Power toggle, Mute, Volume up/down, Channel up/down, Input,
Menu, Up/Down/Left/Right and OK; LG adds Home, Back and Exit. Number keys 0–9 are
available through `tvButtons`. Buttons are services on the same accessory; Apple
Home can display these together or as separate tiles.

Example of per-device LG setup:

```json
"devices": [
  {
    "deviceId": "YOUR_TV_CHILD_DEVICE_ID",
    "tvProfile": "lg",
    "tvButtons": ["power_toggle", "volume_up", "volume_down", "mute", "home", "back", "input"]
  }
]
```

Use the TV child's **device ID**, not the Allone hub UID. Routing to the hub is
handled automatically. An empty `tvButtons` array hides the TV remote accessory.

## Homes and device selection

Leave `familyId` empty to expose supported devices from every home in this
account. Set `familyId` to a specific returned ID to use one home. Use one
OrviboCloud platform instance for an account.

Optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `host` | `homemate.orvibo.com` | Regional cloud server; also Germany, China, USA, or `auto` |
| `familyId` | Empty | All homes, or one exact home ID |
| `pollInterval` | `60` | Refresh every 30–3600 seconds |
| `pushUpdates` | `true` | Additional connection for live cloud device reports |
| `tvProfile` | `stored` | `stored` or `lg`; can be overridden per device |
| `tvButtons` | Main controls | List of visible TV keys; can be overridden per device |
| `includeDeviceIds` | Empty | Include only these IDs; empty means all supported devices |
| `excludeDeviceIds` | Empty | Hide these devices |
| `devices` | Empty | Per-device name, exclusion, TV profile, relay appearance and position reversal |
| `passwordHash` | Empty | Optional uppercase/lowercase MD5 credential instead of `password` |
| `debug` | `false` | Additional names/types and connection messages |

Example filters and device options:

```json
"excludeDeviceIds": ["DEVICE_TO_HIDE"],
"devices": [
  { "deviceId": "CURTAIN_ID", "name": "Bedroom Curtain", "invertPosition": true },
  { "deviceId": "RELAY_ID", "name": "Desk Socket", "exposeAs": "outlet" }
]
```

`invertPosition` affects percentage curtain reads and writes; it does not change
the RF Open and Close button codes. `exposeAs` changes the appearance of a
supported on/off relay; it does not add support for an unrecognized model.

To list home/device IDs using your existing Homebridge configuration, run from
the extracted source directory:

```bash
ORVIBO_CONFIG_PATH=/var/lib/homebridge/config.json npm run discover
```

This performs read-only cloud discovery. It prints home names/IDs, device
names/IDs, types, rooms and supported profiles, with no passwords or tokens.
It does not need `npm install` because discovery has no runtime dependencies.
Alternatively, it accepts `ORVIBO_USERNAME`, `ORVIBO_PASSWORD` or
`ORVIBO_PASSWORD_HASH`, and optional `ORVIBO_HOST`/`ORVIBO_FAMILY_ID` environment
variables. Prefer the existing configuration path over putting credentials in
shell commands or shell history.

## Connection and cache behavior

- The login/discovery path uses signed HTTPS requests with certificate checking.
- Controls and push reports use the source integration's mutual-TLS/AES cloud
  protocol on outbound TCP **10002**. Outbound TCP **443** is also needed. No
  inbound port forwarding is required for the ORVIBO cloud connection.
- The legacy port-10002 server certificate chain requires the same exception as
  the supplied integration. Certificate verification remains enabled for HTTPS.
- The shared application certificate/key in `assets/` are required protocol
  assets copied from the uploaded integration. Your HomeMate credentials and
  transient account/socket tokens are separate.
- Tokens and binary login credentials stay in memory. Accessory cache entries
  contain only normalized device metadata and allowlisted state. The HomeMate
  password or its equivalent MD5 remains in your normal Homebridge config.
- A cloud outage makes accessories unavailable without removing their UUIDs,
  rooms or automations. Push sessions reconnect with backoff; polling continues.
- A temporarily missing cloud device is retained and unavailable. To remove a
  device deliberately, add its ID to `excludeDeviceIds` or set its device option
  `exclude` to `true`. Exclusions take effect after a successful refresh.
- RF/TV controls sharing an Allone hub are serialized so one device's response
  cannot be mistaken for a sibling's response.

## Troubleshooting

**Login rejected:** confirm the same username, password and cloud server work in
the supplied Home Assistant integration. Choosing an explicit server does not
silently switch to another region. No China-only phone-number rule is applied.

**Devices are discovered but unavailable:** check whether discovery reports
`controlCredentialsAvailable: true`, that the device/hub is online, and that the
Homebridge machine can reach the selected server on TCP 10002.

**A device is missing:** run discovery and check its `homebridgeProfile`. Only
the supported profiles above are exposed. Excluding a hub does not hide its
supported children or break their profile detection.

**TV keys are rejected or the wrong TV reacts:** verify that the TV child is
correct in HomeMate. Try the stored profile for HomeMate keys, or LG only for an
LG TV. A stored profile cannot supply Home/Back/Exit keys absent from that profile.

**RF blind controls show as switches:** this is intentional: the supplied
integration has no RF position measurement. The switches can be used in Home
scenes and automations.

## Development and validation

Production installation from the `.tgz` needs no compile step and no additional
runtime packages. To install the development-only Homebridge dependency and run
the source tests:

```bash
npm install
npm run check
npm test
```

The tests include independent vectors generated by executing the uploaded Python
integration's signing, framing and command helpers, a local mutual-TLS cloud
simulator, and real Homebridge/HAP accessory instances. Native HomeKit tests can
also use a separately installed Homebridge via `ORVIBO_HOMEBRIDGE_ROOT`.

See `VALIDATION.md` for the tested versions and results. These checks do not
replace testing against your own HomeMate account and physical devices.

Build a new installable release with `npm pack`. Increment the version before
publishing a subsequent release.

Reference documentation:

- [Homebridge platform API](https://developers.homebridge.io/homebridge/interfaces/API.html)
- [Homebridge plugin settings schema](https://github.com/homebridge/homebridge-config-ui-x/wiki/Developers:-Plugin-Settings-GUI)
- [Source integration attribution](https://github.com/Kosztyk/orvibo_cloud)

Licensed under MIT. The bundled ORVIBO protocol assets retain their original
ownership; see `NOTICE`.
