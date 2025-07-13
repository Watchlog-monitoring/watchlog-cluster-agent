process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err.message);
    // اگر دوست داری بعد از لاگ کردن پروسس رو ببندی یا ری‌استارت کنی، اینجا انجام بده
});

process.on('unhandledRejection', reason => {
    console.error('Unhandled rejection:', reason);
    // اینجا هم می‌تونی cleanup یا ری‌استارت بک‌-اُف بذاری
});

require('app-module-path').addPath(__dirname);
require('dotenv').config()
const App = require('./app');
new App();