## Init local Network

```
    solana-test-validator --reset --rpc-port 8899 --faucet-port 9900 \
    --warp-slot "$(solana slot --url https://api.mainnet.solana.com)" \
    --url https://api.mainnet.solana.com \
    --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
    --clone-upgradeable-program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr \
    --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
    --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
    --clone 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
    --clone d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q \
    --clone GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U \
    --clone So11111111111111111111111111111111111111112 \
    --clone 2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1 \
    --clone 8NXMyRD91p3nof61BTkJvrfpGTASHygz1cUvc3HvwyGS \
    --clone 955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX \
    --clone 3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH 
```

---

## Start tests

`anchor test --skip-local-validator`

Use `yarn validator:local` to start the preconfigured local validator before running the tests.

