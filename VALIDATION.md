# Validation — 1.1.3

Validated on 16 October 2026 with Node.js **24.19.0**.

| Environment | Result |
| --- | --- |
| Homebridge 1.11.4 and its actual HAP implementation | 47 tests passed; 0 failed; 0 skipped |
| Homebridge 2.4.0 and its actual HAP implementation | 47 tests passed; 0 failed; 0 skipped |
| JavaScript syntax checks | All runtime files passed |
| Protocol comparison | Matches vectors executed from the uploaded Python integration 1.1.0 |
| Local mutual-TLS cloud simulator | Handshake, login, controls, rejection, timeout and socket cleanup passed |

The 47 tests cover:

- The account password hash and signatures for both REST request types.
- Byte-for-byte compatibility with the original static-key and dynamic-key AES
  frames, including PKCS7 padding, CRC32 and session headers.
- Fragmented/coalesced frames, split frame markers, bad CRC and key changes
  between frames in a single read.
- All 16 reference device commands, 23 stored TV keys and 26 raw LG NEC signals.
- RF/TV child routing, infrared payload fields and reply correlation.
- Separation of a command acknowledgement from a measured device report.
- Regional host validation, fallback, family selection and secret-free errors.
- Startup with empty/incomplete Device options and blank device ID filters,
  including discovery of two simulated Allone RF blinds through the actual
  Homebridge platform constructor. The regression reproduced the reported
  configuration error before the fix.
- Readtable joins, deleted devices, status-only sensors and cache allowlisting.
- Actual HomeKit light, cover, contact, battery, outlet and momentary switch
  service getters/setters through real Homebridge APIs.
- The Homebridge 1/2 battery-service naming difference.
- RF blind Window Covering service, exact Open/Stop/Close RF commands through
  the three-position selector and Hold Position, unchanged cloud values, and
  rejected commands without automatic retransmission or optimistic selection.
- RF switch-to-covering cache migration without changing UUIDs, and persistence
  of the last accepted command across cloud refresh and cache restoration.
- TV momentary reset, power-toggle rejection without automatic retransmission,
  shared-hub command serialization and offline-hub handling.
- Global TV profile `none` overriding an LG device profile; per-device `none`
  affecting only one of two TVs; disabled TV cache removal at startup during a
  simulated cloud outage, including empty button arrays; and re-enabling the
  same TV UUID while preserving the RF blind accessory.
- Live sensor updates, listener reconnection, shutdown and no sibling broadcast
  state leakage.
- Native accessory serialization/restoration with stable UUIDs and no account
  password, access token or binary password in the accessory cache.
- Retention and recovery during cloud outages or temporarily missing devices.
- Protection against a stale in-flight snapshot overwriting a newer command.

The test data contains fabricated accounts and devices. This release has **not**
been logged into the user's HomeMate account or tested on the user's physical
hardware. A working cloud endpoint and device behavior must be checked after
installation. No production Home Assistant/Homebridge configuration was changed.

Reproduce the Homebridge 2 tests from source with `npm install`, then `npm test`.
To test a separately installed version, set `ORVIBO_HOMEBRIDGE_ROOT` to the
absolute directory containing that version's Homebridge `package.json`.
