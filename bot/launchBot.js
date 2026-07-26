export default function launchBot(bot) {
  const launch = () => {
    bot.telegram.getMe()
      .then(async (info) => {
        console.log(`✅ [Bot] @${info.username} connected`);
        // Set bot commands
        await bot.telegram.setMyCommands([
          { command: 'start', description: 'Open bot main menu' }
        ]);
        bot.launch({ allowedUpdates: ['message', 'callback_query', 'my_chat_member'] });
      })
      .catch(err => {
        console.error('❌ Bot launch failed:', err.message, '— retrying in 5s');
        setTimeout(launch, 5000);
      });
  };
  launch();
}
