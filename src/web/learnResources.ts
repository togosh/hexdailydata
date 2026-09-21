// Classification and destinations from the owner's curated packet, read 2026-09-21.
// Reading a project page is not an operational or safety test of its tools.
export const resourceCheckDate = '2026-09-21';
export const primaryResources = [
  {
    label: 'HEX — project information',
    href: 'https://hex.com/',
    description: 'Project explanations and links to HEX tools.',
  },
  {
    label: 'PulseChain — network information',
    href: 'https://pulsechain.com/',
    description: 'Project entry point for the network and its resources.',
  },
  {
    label: 'HEX interface',
    href: 'https://go.hex.com/',
    description: 'Project-published entry point for interacting with HEX.',
  },
  {
    label: 'PulseX',
    href: 'https://app.pulsex.com/',
    description: 'Project-published entry point for token-swap interfaces on PulseChain.',
  },
] as const;
export const deeperResources = [
  {
    label: 'Contract & technical documentation',
    href: 'https://hex.com/dev',
    description:
      'Project documentation hub linking the contract and explanations, including launch-era material.',
    companion: {
      label: "Contract in Layman's Terms (PDF)",
      href: 'https://hex.com/_assets/docs/HEX_whitepaper.pdf',
    },
  },
  {
    label: 'HEX Staking Deep Dive — historical community guide',
    href: 'https://hexicans.info/documentation/deep-dive/',
    description:
      'Community writing about share mechanics and historical simulations; not an official developer specification.',
    companion: {
      label: 'Original document',
      href: 'https://docs.google.com/document/d/112IkMxL94d5AlXukQonRLlyNlF0_5zmX6k1Z0Stsmo0/edit',
    },
  },
  {
    label: 'CoinFabrik economics audit (2019)',
    href: 'https://www.coinfabrik.com/blog/hex-financial-audit/',
    description:
      'Dated analysis of share economics and an audited commit, published December 27, 2019. It is not a safety or profit guarantee.',
    companion: null,
  },
] as const;
