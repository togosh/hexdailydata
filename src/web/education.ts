// Short answers belong to the lazy Learn route; Home only links there.
export const concepts = [
  {
    id: 'hex',
    anchor: 'hex',
    question: 'What is HEX?',
    answer: 'HEX is a cryptocurrency you can hold or commit to a stake.',
  },
  {
    id: 'staking',
    anchor: 'staking-basics',
    question: 'What happens when I stake?',
    answer:
      'Choose an amount of HEX and a number of days. You cannot spend the committed amount while staked. After the term finishes, the owner must use Stake End to receive the result; maturity does not pay it automatically. Ending early or too late can reduce the payout and starting amount.',
  },
  {
    id: 'tshares',
    anchor: 'tshares',
    question: 'What is a T-Share?',
    answer:
      'A T-Share is one trillion stake shares. Shares determine a stake’s portion of the eligible daily payout pool. T-Shares are a measurement, not a separate token to buy or trade. The share rate affects new stakes; it is not an interest rate.',
  },
  {
    id: 'payout',
    anchor: 'payout',
    question: 'What does payout per T-Share mean?',
    answer:
      'It shows how much HEX one T-Share receives for a day the stake is earning. The amount varies; it is not a guaranteed future rate or a daily deposit into your wallet.',
  },
  {
    id: 'tools',
    anchor: 'buy-stake',
    question: 'How do I buy or stake HEX?',
    answer:
      'HEXDailyData does not sell tokens or execute stakes. The external project resources below are starting points for finding tools. Check the website, network, token and transaction details. Never share your recovery phrase or private key.',
  },
] as const;
