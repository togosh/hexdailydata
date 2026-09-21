// Shared summaries only. Expanded copy and resources belong to the lazy Learn route.
export const concepts = [
  {
    id: 'hex',
    anchor: 'hex',
    question: 'What is HEX?',
    answer:
      'HEX is a cryptocurrency you can hold or stake. Staking means committing HEX for a set number of days to receive a share of the staking payouts.',
  },
  {
    id: 'staking',
    anchor: 'staking-basics',
    question: 'How does staking work?',
    answer:
      "Choose how much HEX to stake and for how long. You can't spend it while staked. Ending early or too late can reduce your payout and starting HEX.",
  },
  {
    id: 'tshares',
    anchor: 'tshares',
    question: 'What is a T-Share?',
    answer:
      "T-Shares measure your stake's share of the daily payout pool. More T-Shares means a bigger share of that pool. They aren't a separate token you buy or trade.",
  },
  {
    id: 'payout',
    anchor: 'payout',
    question: 'What is payout per T-Share?',
    answer:
      "It shows how much HEX one T-Share receives for a day your stake is earning. The amount varies; it isn't a daily deposit into your wallet.",
  },
  {
    id: 'pulsechain',
    anchor: 'pulsechain',
    question: 'Why PulseChain?',
    answer:
      "This site follows HEX on PulseChain. PulseChain is the network; PLS pays its transaction fees. You don't need to connect a wallet to use HEXDailyData.",
  },
] as const;
