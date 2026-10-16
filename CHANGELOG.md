# Changelog

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
