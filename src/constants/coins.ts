export type CoinInfo = {
  symbol: string
  name: string
  coinType: string
  mainnetType: string
  decimals: number
  logoUrl: string
}

export const SUI_COIN_TYPE = '0x2::sui::SUI'

export const COINS: CoinInfo[] = [
  {
    symbol: 'SUI',
    name: 'Sui',
    coinType: SUI_COIN_TYPE,
    mainnetType: '0x2::sui::SUI',
    decimals: 9,
    logoUrl:
      'https://strapi-space-bucket-fra1-1.fra1.cdn.digitaloceanspaces.com/sui_c07df05f00.png',
  },
  {
    symbol: 'WAL',
    name: 'Walrus',
    coinType:
      '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL',
    mainnetType:
      '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    decimals: 9,
    logoUrl:
      'https://strapi-space-bucket-fra1-1.fra1.cdn.digitaloceanspaces.com/Walrus_coin_2cb483fb74.png',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    coinType:
      '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
    mainnetType:
      '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
    logoUrl:
      'https://strapi-space-bucket-fra1-1.fra1.cdn.digitaloceanspaces.com/usdc_03b37ed889.png',
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    coinType:
      '0xd4e8b2874af2ccd2f067dc208ffc25a420b0c7a91d8f71c249f730d2e158afeb::eth::ETH',
    mainnetType:
      '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH',
    decimals: 8,
    logoUrl: 'https://bridge-assets.sui.io/eth.png',
  },
  {
    symbol: 'K_COIN',
    name: 'Kalvium Coin',
    coinType:
      '0x1faf161a7eaebaeca42f65a7781691176df8e5a1c62d23397409a066e23aa0dc::k_coin::K_COIN',
    mainnetType: '',
    decimals: 9,
    logoUrl:
      'https://res.cloudinary.com/dxflnmfxl/image/upload/v1772019907/k_coin_pd0rg6.png',
  },
]

export const COIN_BY_TYPE: Record<string, CoinInfo> = Object.fromEntries(
  COINS.map((coin) => [coin.coinType, coin]),
)
