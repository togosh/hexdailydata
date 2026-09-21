// Shared summaries only. Expanded copy and resources belong to the lazy Learn route.
export const concepts = [
  {
    id: 'hex',
    anchor: 'hex',
    question: 'What is HEX?',
    answer:
      "HEX is a token with a built-in time-lock staking system. You can hold it as liquid HEX or commit an amount for a chosen term; the stake's shares determine its allocation of HEX payouts. HEXDailyData focuses on HEX on PulseChain.",
  },
  {
    id: 'staking',
    anchor: 'staking-basics',
    question: 'What does staking HEX mean?',
    answer:
      'You choose an amount and a term. The contract records a stake, and those HEX are no longer available to transfer. Maturity does not automatically pay you: the stake must be ended to settle it. Ending early or too late can reduce the return, including principal.',
  },
  {
    id: 'tshares',
    anchor: 'tshares',
    question: 'What is a T-Share?',
    answer:
      "A T-Share is one trillion stake shares, not a separate tradable token. Shares measure a stake's portion of the daily HEX payout pool. The amount staked, its duration and the share rate at creation determine how many shares it receives.",
  },
  {
    id: 'payout',
    anchor: 'payout',
    question: 'What does payout per T-Share mean?',
    answer:
      "It is the HEX payout allocation for one T-Share on a particular protocol day. Multiply it by a stake's eligible T-Shares for an approximate daily allocation. It is not a daily wallet payment; today's estimate and a completed day's recorded payout are separate.",
  },
  {
    id: 'pulsechain',
    anchor: 'pulsechain',
    question: 'Why PulseChain?',
    answer:
      'PulseChain is the network used by the HEX product shown here; PLS is its transaction-fee token. Some inherited stakes began before the fork, but our HEX price history uses PulseChain observations only. HEXDailyData does not require you to connect a wallet.',
  },
] as const;
