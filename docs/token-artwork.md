# Local token artwork

These files identify the named assets; they do not imply endorsement. Downloaded
2026-09-20. No runtime hotlinks, fonts or icon service. Existing project/site rights
remain with their owners. HEX and PulseX branding pages describe identification use;
BitPay's Bitcoin artwork is CC0. Ethereum's source is its official website repository.

| Asset | Source | Local bytes |
|---|---|---:|
| HEX | https://hex.com/downloads/logo/HEXagon.svg (https://hex.com/downloads/) | 1405 |
| BTC | https://raw.githubusercontent.com/bitpay/bitcoin-brand/master/bitcoin.svg | 956 |
| ETH | https://raw.githubusercontent.com/ethereum/ethereum-org-website/dev/public/images/assets/svgs/eth-diamond-purple.svg (https://ethereum.org/assets) | 404 |
| PLS | https://pulsechain.com/Branding.zip, Branding/Logo/LogoVector.svg | 1565 |
| PLSX | https://pulsex.com/brand/downloads/logo/PulseX_X.svg (https://pulsex.com/brand/) | 789 |
| INC | https://tokens.app.pulsex.com/images/tokens/0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d.png | 7975 |
| PRVX | https://provex.com/static/logo/logo-80.webp | 2758 |

SVGs optimized with SVGO 4.0.0, retaining paths/colors/gradients. Raster originals
retained byte-for-byte. Total 15,852 bytes before HTTP compression. The PulseChain
site itself references the INC image and the PRVX contract F6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11;
PulseX's branding page independently identifies the INC contract above. ProveX's own
homepage serves the downloaded 80px logo. These are static artwork lookups, not live
price/RPC calls or qualification of data feeds.

Images have explicit dimensions and contain sizing; decorative alt text because
adjacent labels name the assets. HEX is eager; six market logos lazy-load and decode
asynchronously. Vite emits separate content-hashed files (no-inline), avoiding binary
image payloads in the critical JavaScript bundle and allowing browser cache reuse.
