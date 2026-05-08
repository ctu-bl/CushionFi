# Simulate (mock:sol-cycle:local)

Short smoke flow to verify keeper behavior on `klend_mock`:
- bootstrap/open a position
- run `inject -> withdraw -> inject -> liquidate`
- keeper should call internal Cushion liquidation at the end

## Run

1. In terminal A, start keeper:

```bash
yarn keeper:start
```

2. In terminal B, run simulation:

```bash
yarn mock:sol-cycle:local
```

## Success signals

In keeper logs, look for:
- `executor.inject_submitted`
- `executor.liquidate_submitted`

After liquidation, you should see:
- `ltvAfter: "0"` (or `0.0000%`)
- `injectedAfter: false`
- next `risk_snapshot` has `debtValueSf: "0"`

This means liquidation repaid debt and cleared the injected state.
