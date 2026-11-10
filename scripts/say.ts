/** Send one chat line to the bot from a throwaway offline player: `npx tsx scripts/say.ts "!goal Find diamond"`. */
import mineflayer from 'mineflayer'
import { config } from '../src/config.ts'

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: process.env.SAY_USER ?? 'Boss',
  auth: 'offline',
  ...(config.version ? { version: config.version } : {}),
})

bot.once('spawn', async () => {
  await bot.waitForTicks(20)
  bot.chat(process.argv.slice(2).join(' '))
  await bot.waitForTicks(20)
  bot.quit()
})
bot.on('error', (err) => {
  console.error(err.message)
  process.exit(1)
})
