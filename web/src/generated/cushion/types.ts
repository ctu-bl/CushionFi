/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/cushion.json`.
 */
export type Cushion = {
  "address": "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W",
  "metadata": {
    "name": "cushion",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "borrowAsset",
      "discriminator": [
        137,
        132,
        185,
        253,
        184,
        171,
        113,
        203
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "borrowReserve",
          "writable": true
        },
        {
          "name": "borrowReserveLiquidityMint"
        },
        {
          "name": "reserveSourceLiquidity",
          "writable": true
        },
        {
          "name": "borrowReserveLiquidityFeeReceiver",
          "writable": true
        },
        {
          "name": "positionBorrowAccount",
          "writable": true
        },
        {
          "name": "userDestinationLiquidity",
          "writable": true
        },
        {
          "name": "referrerTokenState",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "instructionSysvarAccount",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true,
          "optional": true
        },
        {
          "name": "reserveFarmState",
          "writable": true,
          "optional": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "decreaseCollateral",
      "discriminator": [
        82,
        35,
        149,
        4,
        134,
        77,
        244,
        33
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "positionCollateralAccount",
          "writable": true
        },
        {
          "name": "userCollateralAccount",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "withdrawReserve",
          "writable": true
        },
        {
          "name": "lendingMarket",
          "writable": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveSourceCollateral",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "placeholderUserDestinationCollateral"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "assetMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "userAssetAccount",
          "writable": true
        },
        {
          "name": "userShareAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "assetsIn",
          "type": "u64"
        },
        {
          "name": "minSharesOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "increaseCollateral",
      "discriminator": [
        1,
        137,
        201,
        224,
        62,
        144,
        201,
        182
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "positionCollateralAccount",
          "writable": true
        },
        {
          "name": "userCollateralAccount",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "klendReserve",
          "writable": true
        },
        {
          "name": "lendingMarket",
          "writable": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "reserveDestinationDepositCollateral",
          "writable": true
        },
        {
          "name": "placeholderUserDestinationCollateral",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "increaseDebt",
      "discriminator": [
        33,
        15,
        146,
        233,
        128,
        45,
        27,
        229
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Borrower signing the debt-increase request."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "docs": [
            "Cushion obligation wrapper linked to the position NFT."
          ],
          "writable": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position.nft_mint",
                "account": "obligation"
              }
            ]
          }
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "borrowReserve",
          "writable": true
        },
        {
          "name": "borrowReserveLiquidityMint",
          "docs": [
            "SPL mint of the reserve liquidity being borrowed."
          ]
        },
        {
          "name": "reserveSourceLiquidity",
          "docs": [
            "Reserve liquidity vault that sends tokens out during the borrow CPI."
          ],
          "writable": true
        },
        {
          "name": "borrowReserveLiquidityFeeReceiver",
          "docs": [
            "Fee receiver configured by the Kamino reserve for borrow fees."
          ],
          "writable": true
        },
        {
          "name": "positionBorrowAccount",
          "docs": [
            "Temporary PDA-owned token account that receives the borrowed liquidity first."
          ],
          "writable": true
        },
        {
          "name": "userDestinationLiquidity",
          "docs": [
            "User ATA that receives liquidity after the PDA-to-user transfer."
          ],
          "writable": true
        },
        {
          "name": "referrerTokenState",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "SPL token program used both by Kamino CPI and the final user transfer."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true,
          "optional": true
        },
        {
          "name": "reserveFarmState",
          "writable": true,
          "optional": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initCollection",
      "discriminator": [
        244,
        242,
        133,
        0,
        152,
        187,
        144,
        139
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "collection",
          "docs": [
            "NFT keypair for the collection — account doesn't exist yet"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "positionRegistry",
          "docs": [
            "Registry PDA acts as update_authority for the collection"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        }
      ],
      "args": []
    },
    {
      "name": "initPosition",
      "discriminator": [
        197,
        20,
        10,
        1,
        97,
        160,
        177,
        91
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint",
          "docs": [
            "NFT keypair — account doesn't exist yet, will be created in this instruction"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "collection",
          "docs": [
            "Cushion collection in which we are minting"
          ],
          "writable": true
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "positionRegistry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "positionRegistryEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "klendUserMetadata",
          "writable": true
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "klendReserve",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        }
      ],
      "args": []
    },
    {
      "name": "initPositionRegistry",
      "discriminator": [
        177,
        221,
        98,
        50,
        140,
        12,
        224,
        245
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "positionRegistry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initVault",
      "discriminator": [
        77,
        79,
        85,
        150,
        33,
        217,
        52,
        106
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "assetMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  104,
                  97,
                  114,
                  101,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "treasuryTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "minDeposit",
          "type": "u64"
        },
        {
          "name": "depositCap",
          "type": "u64"
        },
        {
          "name": "virtualAssets",
          "type": "u64"
        },
        {
          "name": "virtualShares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "injectCollateral",
      "discriminator": [
        243,
        219,
        245,
        237,
        79,
        244,
        66,
        14
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "assetMint",
          "relations": [
            "cushionVault"
          ]
        },
        {
          "name": "cushionVault",
          "docs": [
            "Cushion vault providing the liquidity to the obligation"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position.nft_mint",
                "account": "obligation"
              }
            ]
          }
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault token account that provides liquidity"
          ],
          "writable": true,
          "relations": [
            "cushionVault"
          ]
        },
        {
          "name": "positionCollateralAccount",
          "docs": [
            "Program PDA token account (position authority ATA) that temporarily holds tokens"
          ],
          "writable": true
        },
        {
          "name": "klendObligation",
          "docs": [
            "Kamino obligation (CHECKED via owner)"
          ],
          "writable": true
        },
        {
          "name": "klendReserve",
          "docs": [
            "Kamino reserve account"
          ],
          "writable": true
        },
        {
          "name": "reserveLiquiditySupply",
          "docs": [
            "Kamino reserve liquidity supply"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "SPL token program associated with the token used as a collateral"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "klendProgram",
          "docs": [
            "Kamino LB program"
          ]
        },
        {
          "name": "farmsProgram",
          "docs": [
            "Farms program"
          ]
        },
        {
          "name": "lendingMarket",
          "docs": [
            "Kamino CPI needed accounts"
          ],
          "writable": true
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "reserveDestinationDepositCollateral",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "placeholderUserDestinationCollateral"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "insureExistingPosition",
      "discriminator": [
        160,
        35,
        6,
        168,
        109,
        250,
        184,
        87
      ],
      "accounts": [
        {
          "name": "dummy",
          "docs": [
            "is read or written and the account is not trusted for authorization."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "liquidate",
      "discriminator": [
        223,
        179,
        226,
        125,
        48,
        46,
        39,
        74
      ],
      "accounts": [
        {
          "name": "dummy",
          "docs": [
            "is read or written and the account is not trusted for authorization."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "mint",
      "discriminator": [
        51,
        57,
        225,
        47,
        182,
        146,
        137,
        166
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "assetMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "userAssetAccount",
          "writable": true
        },
        {
          "name": "userShareAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesOut",
          "type": "u64"
        },
        {
          "name": "maxAssetsIn",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeem",
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "assetMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "userAssetAccount",
          "writable": true
        },
        {
          "name": "userShareAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesIn",
          "type": "u64"
        },
        {
          "name": "minAssetsOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "repayDebt",
      "discriminator": [
        79,
        200,
        30,
        15,
        252,
        22,
        162,
        8
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "NFT owner signing the repay request; tokens are pulled from their ATA."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "docs": [
            "Cushion obligation wrapper linked to the position NFT."
          ],
          "writable": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position.nft_mint",
                "account": "obligation"
              }
            ]
          }
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "repayReserve",
          "writable": true
        },
        {
          "name": "repayReserveLiquidityMint",
          "docs": [
            "SPL mint of the reserve liquidity being repaid."
          ]
        },
        {
          "name": "reserveDestinationLiquidity",
          "docs": [
            "Reserve liquidity vault that receives repaid tokens."
          ],
          "writable": true
        },
        {
          "name": "userSourceLiquidity",
          "docs": [
            "User ATA holding the debt tokens to repay."
          ],
          "writable": true
        },
        {
          "name": "positionRepayAccount",
          "docs": [
            "Position's ATA (owned by position_authority) used as staging for the Kamino repay CPI."
          ],
          "writable": true
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        },
        {
          "name": "obligationFarmUserState",
          "writable": true,
          "optional": true
        },
        {
          "name": "reserveFarmState",
          "writable": true,
          "optional": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "SPL token program used by Kamino CPI."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateMarketPrice",
      "discriminator": [
        5,
        156,
        156,
        136,
        15,
        222,
        164,
        92
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "vault.asset_mint",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "priceUpdate"
        }
      ],
      "args": [
        {
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "assetMint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "userAssetAccount",
          "writable": true
        },
        {
          "name": "userShareAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "assetsOut",
          "type": "u64"
        },
        {
          "name": "maxSharesBurn",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawInjectedCollateral",
      "discriminator": [
        125,
        44,
        99,
        188,
        85,
        253,
        93,
        110
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "assetMint",
          "relations": [
            "cushionVault"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "cushionVault",
          "docs": [
            "Cushion vault providing the liquidity to the obligation"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101,
                  95,
                  118,
                  49
                ]
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  97,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault token account that provides liquidity"
          ],
          "writable": true,
          "relations": [
            "cushionVault"
          ]
        },
        {
          "name": "positionCollateralAccount",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "klendProgram"
        },
        {
          "name": "klendObligation",
          "writable": true
        },
        {
          "name": "withdrawReserve",
          "writable": true
        },
        {
          "name": "lendingMarket",
          "writable": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveSourceCollateral",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "placeholderUserDestinationCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "pythOracle",
          "optional": true
        },
        {
          "name": "switchboardPriceOracle",
          "optional": true
        },
        {
          "name": "switchboardTwapOracle",
          "optional": true
        },
        {
          "name": "scopePrices",
          "optional": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "obligation",
      "discriminator": [
        168,
        206,
        141,
        106,
        88,
        76,
        172,
        167
      ]
    },
    {
      "name": "positionRegistry",
      "discriminator": [
        82,
        58,
        183,
        208,
        57,
        172,
        38,
        224
      ]
    },
    {
      "name": "positionRegistryEntry",
      "discriminator": [
        6,
        212,
        83,
        33,
        86,
        113,
        13,
        167
      ]
    },
    {
      "name": "priceUpdateV2",
      "discriminator": [
        34,
        241,
        35,
        99,
        157,
        126,
        244,
        205
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "accInterestUpdateEvent",
      "discriminator": [
        236,
        105,
        68,
        132,
        182,
        8,
        43,
        118
      ]
    },
    {
      "name": "collateralDecreasedEvent",
      "discriminator": [
        122,
        42,
        113,
        188,
        74,
        169,
        37,
        127
      ]
    },
    {
      "name": "collateralIncreasedEvent",
      "discriminator": [
        24,
        154,
        80,
        31,
        169,
        150,
        225,
        45
      ]
    },
    {
      "name": "debtIncreasedEvent",
      "discriminator": [
        245,
        189,
        213,
        180,
        247,
        69,
        85,
        5
      ]
    },
    {
      "name": "debtRepaidEvent",
      "discriminator": [
        57,
        46,
        91,
        106,
        180,
        93,
        128,
        6
      ]
    },
    {
      "name": "injectEvent",
      "discriminator": [
        190,
        238,
        175,
        0,
        84,
        66,
        207,
        240
      ]
    },
    {
      "name": "liquidateEvent",
      "discriminator": [
        158,
        94,
        144,
        4,
        147,
        52,
        5,
        255
      ]
    },
    {
      "name": "loanTakenEvent",
      "discriminator": [
        135,
        214,
        13,
        210,
        161,
        80,
        141,
        245
      ]
    },
    {
      "name": "vaultDepositEvent",
      "discriminator": [
        187,
        186,
        196,
        189,
        175,
        44,
        10,
        64
      ]
    },
    {
      "name": "vaultInitializedEvent",
      "discriminator": [
        203,
        214,
        91,
        5,
        185,
        248,
        192,
        149
      ]
    },
    {
      "name": "vaultMintEvent",
      "discriminator": [
        234,
        202,
        201,
        67,
        158,
        161,
        114,
        218
      ]
    },
    {
      "name": "vaultRedeemEvent",
      "discriminator": [
        217,
        58,
        216,
        14,
        209,
        205,
        108,
        26
      ]
    },
    {
      "name": "vaultWithdrawEvent",
      "discriminator": [
        192,
        143,
        53,
        201,
        67,
        20,
        212,
        195
      ]
    },
    {
      "name": "withdrawInjectedEvent",
      "discriminator": [
        146,
        209,
        72,
        170,
        202,
        103,
        136,
        185
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6001,
      "name": "overflow",
      "msg": "overflow"
    },
    {
      "code": 6002,
      "name": "zeroCollateralAmount",
      "msg": "Collateral amount can't be zero when creating the position"
    },
    {
      "code": 6003,
      "name": "zeroDebtAmount",
      "msg": "Debt amount can't be zero"
    },
    {
      "code": 6004,
      "name": "zeroRepayAmount",
      "msg": "Amount for repaying can't be zero"
    },
    {
      "code": 6005,
      "name": "unsafePosition",
      "msg": "Position is too close to liquidation and cannot be insured"
    },
    {
      "code": 6006,
      "name": "zeroDepositAmount",
      "msg": "Deposit amount cannot be zero"
    },
    {
      "code": 6007,
      "name": "zeroWithdrawAmount",
      "msg": "Withdraw amount cannot be zero"
    },
    {
      "code": 6008,
      "name": "zeroMintAmount",
      "msg": "Mint amount cannot be zero"
    },
    {
      "code": 6009,
      "name": "zeroRedeemAmount",
      "msg": "Redeem amount cannot be zero"
    },
    {
      "code": 6010,
      "name": "vaultPaused",
      "msg": "Vault is paused"
    },
    {
      "code": 6011,
      "name": "withdrawalsPaused",
      "msg": "Withdrawals are paused"
    },
    {
      "code": 6012,
      "name": "depositTooSmall",
      "msg": "Deposit amount is below vault minimum"
    },
    {
      "code": 6013,
      "name": "depositCapExceeded",
      "msg": "Vault deposit cap exceeded"
    },
    {
      "code": 6014,
      "name": "zeroSharesOut",
      "msg": "Share output rounded down to zero"
    },
    {
      "code": 6015,
      "name": "zeroAssetsOut",
      "msg": "Asset output rounded down to zero"
    },
    {
      "code": 6016,
      "name": "insufficientVaultLiquidity",
      "msg": "Vault does not have enough idle liquidity"
    },
    {
      "code": 6017,
      "name": "insufficientRepayLiquidity",
      "msg": "Insufficient liquidity in user's source account"
    },
    {
      "code": 6018,
      "name": "invalidAssetMint",
      "msg": "Invalid asset mint account"
    },
    {
      "code": 6019,
      "name": "invalidShareMint",
      "msg": "Invalid share mint account"
    },
    {
      "code": 6020,
      "name": "invalidVaultTokenAccount",
      "msg": "Invalid vault token account"
    },
    {
      "code": 6021,
      "name": "invalidTreasuryAccount",
      "msg": "Invalid treasury token account"
    },
    {
      "code": 6022,
      "name": "invalidDepositCap",
      "msg": "Invalid deposit cap configuration"
    },
    {
      "code": 6023,
      "name": "divisionByZero",
      "msg": "Division by zero"
    },
    {
      "code": 6024,
      "name": "castError",
      "msg": "Cast error"
    },
    {
      "code": 6025,
      "name": "stalePythPrice",
      "msg": "Pyth price is stale or unavailable"
    },
    {
      "code": 6026,
      "name": "invalidPythPrice",
      "msg": "Pyth price is negative or zero"
    },
    {
      "code": 6027,
      "name": "minSharesOutNotMet",
      "msg": "Slippage: min shares out not met"
    },
    {
      "code": 6028,
      "name": "maxAssetsInExceeded",
      "msg": "Slippage: max assets in exceeded"
    },
    {
      "code": 6029,
      "name": "minAssetsOutNotMet",
      "msg": "Slippage: min assets out not met"
    },
    {
      "code": 6030,
      "name": "maxSharesBurnExceeded",
      "msg": "Slippage: max shares burn exceeded"
    },
    {
      "code": 6031,
      "name": "invalidKaminoProgram",
      "msg": "Invalid Kamino program account"
    },
    {
      "code": 6032,
      "name": "invalidKaminoUserMetadata",
      "msg": "Invalid Kamino user metadata PDA"
    },
    {
      "code": 6033,
      "name": "invalidKaminoObligation",
      "msg": "Invalid Kamino obligation PDA"
    },
    {
      "code": 6034,
      "name": "invalidKaminoLendingMarketAuthority",
      "msg": "Invalid Kamino lending market authority PDA"
    },
    {
      "code": 6035,
      "name": "invalidKaminoFarmUserState",
      "msg": "Invalid Kamino farm user state PDA"
    },
    {
      "code": 6036,
      "name": "invalidPositionNftMint",
      "msg": "Invalid NFT token account mint for Cushion position"
    },
    {
      "code": 6037,
      "name": "invalidPositionNftOwner",
      "msg": "NFT token account owner must match signer"
    },
    {
      "code": 6038,
      "name": "reserveAlreadyUsedOnOtherSide",
      "msg": "Reserve is already used as a borrow on this obligation"
    },
    {
      "code": 6039,
      "name": "missingKaminoRefreshReserve",
      "msg": "A required Kamino reserve account is missing from remaining accounts"
    },
    {
      "code": 6040,
      "name": "injectedCollateral",
      "msg": "Position has injected collateral and cannot be decreased"
    },
    {
      "code": 6041,
      "name": "marketValueError",
      "msg": "Failed to compute market value from reserve data"
    },
    {
      "code": 6042,
      "name": "ltvComputationError",
      "msg": "Failed to compute potential LTV"
    },
    {
      "code": 6043,
      "name": "unsafeDecreaseCollateral",
      "msg": "Collateral decrease would put position below safe LTV threshold"
    },
    {
      "code": 6044,
      "name": "deserializationError",
      "msg": "Failed to deserialize account data"
    },
    {
      "code": 6045,
      "name": "alreadyInjected",
      "msg": "Position already has injected collateral"
    },
    {
      "code": 6046,
      "name": "notUnsafePosition",
      "msg": "Position is not unsafe, injection failed"
    },
    {
      "code": 6047,
      "name": "injectCalculationError",
      "msg": "Amount to inject calculation failed"
    },
    {
      "code": 6048,
      "name": "ltvCalculationError",
      "msg": "Calculation of current LTV failed"
    },
    {
      "code": 6049,
      "name": "zeroPrice",
      "msg": "Price of the asset in vault is zero"
    },
    {
      "code": 6050,
      "name": "insuringThresholdError",
      "msg": "Computation of insuring LTV threshold failed"
    },
    {
      "code": 6051,
      "name": "notInjected",
      "msg": "Position doesn't have any injected collateral"
    },
    {
      "code": 6052,
      "name": "withdrawingThresholdError",
      "msg": "Computation of withdrawing LTV threshold failed"
    },
    {
      "code": 6053,
      "name": "notYetSafePosition",
      "msg": "Position is not safe enough, withdrawal failed"
    },
    {
      "code": 6054,
      "name": "withdrawAmountCalculationError",
      "msg": "Computation of amount to withdraw failed"
    },
    {
      "code": 6055,
      "name": "interestCalculationError",
      "msg": "Computation of accumulated interest failed"
    },
    {
      "code": 6056,
      "name": "withdrawAmountIsZero",
      "msg": "Withdraw amount cannot be zero"
    },
    {
      "code": 6057,
      "name": "withdrawValueError",
      "msg": "Calculation of withdraw value failed"
    }
  ],
  "types": [
    {
      "name": "accInterestUpdateEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAi",
            "type": "u64"
          },
          {
            "name": "newAi",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "collateralDecreasedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "colDecreaseValue",
            "type": "u64"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "collateralIncreasedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "colIncreaseValue",
            "type": "u64"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "debtIncreasedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "debtIncreaseValue",
            "type": "u64"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          },
          {
            "name": "hf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "debtRepaidEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "repayValue",
            "type": "u64"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "injectEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          },
          {
            "name": "injectedAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "liquidateEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          },
          {
            "name": "collateralAmountLiquidated",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "loanTakenEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "colValue",
            "type": "u64"
          },
          {
            "name": "debtValue",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "obligation",
      "docs": [
        "Wrapper account that references a Kamino obligation managed by a Cushion position.",
        "",
        "This account does NOT store lending state",
        "It only references an existing Kamino obligation account",
        "",
        "Security invariants:",
        "- `owner` MUST match the owner inside the underlying Kamino obligation"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nftMint",
            "docs": [
              "NFT mint that deterministically identifies this Cushion position."
            ],
            "type": "pubkey"
          },
          {
            "name": "positionAuthority",
            "docs": [
              "Cushion position authority PDA used for CPI signing."
            ],
            "type": "pubkey"
          },
          {
            "name": "owner",
            "docs": [
              "Owner of this wrapper is also the owner of the underlying Kamino obligation."
            ],
            "type": "pubkey"
          },
          {
            "name": "borrower",
            "docs": [
              "Borrower associated with the Cushion position."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolObligation",
            "docs": [
              "Address of the underlying Kamino obligation account."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolUserMetadata",
            "docs": [
              "Kamino user metadata PDA linked to the position authority PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralVault",
            "docs": [
              "Vault that injects additional collateral"
            ],
            "type": "pubkey"
          },
          {
            "name": "injectedAmount",
            "docs": [
              "amount of tokens injected into the obligation"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump for PDA signing"
            ],
            "type": "u8"
          },
          {
            "name": "injected",
            "docs": [
              "Flag whether it is injected additional collateral"
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "positionRegistry",
      "docs": [
        "Global position registry PDA.",
        "",
        "This account is only an on-chain aggregator/index root.",
        "It is NOT an authority for position actions."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalPositions",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "positionRegistryEntry",
      "docs": [
        "Per-position registry entry, keyed by NFT mint.",
        "",
        "This mirrors key references for indexing and discovery.",
        "Source of truth for authority remains the NFT/ATA ownership checks",
        "and the `position` PDA."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nftMint",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "positionAuthority",
            "type": "pubkey"
          },
          {
            "name": "borrower",
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "On-chain state for a single Cushion vault that tracks mint relationships,",
        "accounting parameters, and aggregate managed assets."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump used for signing."
            ],
            "type": "u8"
          },
          {
            "name": "authority",
            "docs": [
              "Authority allowed to manage vault parameters."
            ],
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "docs": [
              "Underlying SPL token mint held by the vault."
            ],
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "docs": [
              "Mint for vault shares."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultTokenAccount",
            "docs": [
              "Token account holding idle underlying assets."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasuryTokenAccount",
            "docs": [
              "Treasury token account (reserved for future fee logic)."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalManagedAssets",
            "docs": [
              "Source of truth for total assets economically managed by the vault."
            ],
            "type": "u128"
          },
          {
            "name": "minDeposit",
            "docs": [
              "Minimum accepted deposit amount."
            ],
            "type": "u64"
          },
          {
            "name": "depositCap",
            "docs": [
              "Hard cap for total managed assets."
            ],
            "type": "u64"
          },
          {
            "name": "virtualAssets",
            "docs": [
              "Virtual assets used in share conversion."
            ],
            "type": "u64"
          },
          {
            "name": "virtualShares",
            "docs": [
              "Virtual shares used in share conversion."
            ],
            "type": "u64"
          },
          {
            "name": "marketPrice",
            "docs": [
              "Price of the underlying asset."
            ],
            "type": "u128"
          },
          {
            "name": "marketPriceLastUpdated",
            "docs": [
              "Last timestamp when the market price was updated."
            ],
            "type": "i64"
          },
          {
            "name": "interestLastUpdated",
            "docs": [
              "Last timestamp when the accumulated interest was updated."
            ],
            "type": "i64"
          },
          {
            "name": "accumulatedInterest",
            "docs": [
              "Accumulated interest of the vault."
            ],
            "type": "u64"
          },
          {
            "name": "interestRate",
            "docs": [
              "Interest rate of the vault."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultDepositEvent",
      "docs": [
        "Emitted when a user deposits assets and receives freshly minted vault",
        "shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "assetsIn",
            "type": "u64"
          },
          {
            "name": "sharesOut",
            "type": "u64"
          },
          {
            "name": "totalManagedAssets",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "vaultInitializedEvent",
      "docs": [
        "Emitted when a new vault is initialized for an underlying asset mint."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "minDeposit",
            "type": "u64"
          },
          {
            "name": "depositCap",
            "type": "u64"
          },
          {
            "name": "virtualAssets",
            "type": "u64"
          },
          {
            "name": "virtualShares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultMintEvent",
      "docs": [
        "Emitted when a user mints an exact amount of shares and transfers the",
        "required underlying assets into the vault."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "assetsIn",
            "type": "u64"
          },
          {
            "name": "sharesOut",
            "type": "u64"
          },
          {
            "name": "totalManagedAssets",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "vaultRedeemEvent",
      "docs": [
        "Emitted when a user redeems shares for underlying assets withdrawn from the",
        "vault."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "sharesIn",
            "type": "u64"
          },
          {
            "name": "assetsOut",
            "type": "u64"
          },
          {
            "name": "totalManagedAssets",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "vaultWithdrawEvent",
      "docs": [
        "Emitted when a user withdraws an exact amount of assets and burns the",
        "necessary vault shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "assetsOut",
            "type": "u64"
          },
          {
            "name": "sharesBurned",
            "type": "u64"
          },
          {
            "name": "totalManagedAssets",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    },
    {
      "name": "withdrawInjectedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "obligation",
            "type": "pubkey"
          },
          {
            "name": "withdrawnAmount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
