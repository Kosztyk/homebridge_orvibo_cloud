# Changelog

## 1.1.4 — 2026-10-22

- Use standard object-level required arrays in the configuration schema while preserving mandatory fields.

## 1.1.3

- Add an explicit `none` TV profile that disables all TV remotes, including LG
  device overrides. Support `none` per device to hide an individual TV.
- Remove explicitly excluded and disabled cached accessories before discovery,
  including when the ORVIBO cloud is unavailable.
- Clarify that clearing an optional settings field may restore default buttons;
  the explicit `none` profile reliably preserves the disabled setting.
- Verify TV cache removal, unaffected blind identities and TV re-enabling with
  actual Homebridge 1 and 2 APIs.
- Correct the settings header to describe RF blinds as blind accessories.

## 1.1.2

- Show each Allone RF blind as one primary HomeKit Window Covering accessory.
- Map the native control's three positions to Close (0), Stop (50), and Open
  (100); also support Stop through HomeKit Hold Position. These values select
  commands and do not claim RF position feedback or percentage positioning.
- Remember the last accepted RF command across polling and cache restoration.
- Migrate cached blind accessories automatically, preserving their UUIDs and
  removing the old Open/Close/Stop switches.
- Verify RF routing, single-send failures and cache migration with real
  Homebridge 1 and 2 APIs.

## 1.1.1

- Fix discovery failing to start when Homebridge settings contain an empty or
  incomplete Device options row. Ignore these rows with a warning.
- Ignore blank include/exclude device IDs so an unused settings field cannot
  hide every discovered device; trim whitespace around device IDs.
- Add regression tests for startup and discovery of two Allone RF blinds with
  incomplete settings, using actual Homebridge 1 and 2 APIs.

## 1.1.0

- Bump the package and release files to 1.1.0.

## 1.0.0

- Initial standalone Node.js port of the supplied ORVIBO Cloud integration.
- Signed cloud discovery with selectable regional servers and multiple homes.
- Curtains, RF blind buttons, supported relay and tunable lights.
- Allone Pro stored-key and LG infrared remote buttons.
- Door contact and battery services, with live cloud state updates and polling.
- Homebridge settings form, device filters and per-device options.
- Cached accessory identity, cloud reconnects and secret-free diagnostics.
