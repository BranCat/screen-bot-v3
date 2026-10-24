// config.js — Robinhood Chain network + contract addresses.
//
// Sources (cross-checked against 3 independent docs, Aug 2026):
//   https://docs.bags.fm/robinhood/overview
//   https://docs.bags.fm/robinhood/contracts
//   https://developers.uniswap.org/docs/protocols/v4/deployments
//
// If Robinhood Chain ever isn't natively selectable in your Tenderly
// project (network_id 4663), add it as a custom RPC / Virtual TestNet in
// the Tenderly dashboard first, using CHAIN_ID + RPC_URL below.

module.exports = {
  CHAIN_ID: 4663,
  CHAIN_ID_STR: '4663',
  RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',

  ADDR: {
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    UNIVERSAL_ROUTER: '0x8876789976dEcBfCbBbe364623C63652db8C0904', // modified fork — see minHopPriceX36 note in tenderly-bundle-v4.js
    UNIV4_POOL_MANAGER: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    V4_QUOTER: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
    ZERO: '0x0000000000000000000000000000000000000000', // Currency "native ETH" sentinel

    // USDG (Paxos Global Dollar), 6 decimals. Source: docs.paxos.com/guides/stablecoin/usdg/mainnet
    // (Robinhood Mainnet row). Independently proved on 2026-09-28: it hashes back to the recorded
    // poolId of all 25 USDG-paired pools in v2-screening-data.jsonl.
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',

    // v4 read-only lens. Was hard-coded as a fallback in pool-state.js and liquidity-sweep.js.
    UNIV4_STATE_VIEW: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    // v4 PositionManager (ERC721; a position's salt is its tokenId). docs.bags.fm/robinhood/contracts
    UNIV4_POSITION_MANAGER: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',

    // Pons launchpad (docs.bitquery.io/docs/blockchain/robinhood/pons-api, Sept 2026).
    // Graduated Pons pools carry the meme hook; the locker holds the pool's LP NFT permanently.
    PONS_V2_MEME_HOOK: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
    PONS_V2_LAUNCH_LOCKER: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    PONS_V2_LAUNCH_FACTORY: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',

    // Uniswap V3 — standard/unmodified @uniswap/v3-periphery + swap-router-contracts
    // deployment (per developers.uniswap.org/docs/protocols/v3/deployments,
    // Aug 2026) — unlike the V4 UniversalRouter, this is NOT a Bags/Robinhood
    // fork, so it uses classic ERC20 approve()+transferFrom, no Permit2.
    UNISWAP_V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    SWAP_ROUTER_02: '0xCaf681a66D020601342297493863E78C959E5cb2',
    V3_QUOTER: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  },
};
