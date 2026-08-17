const fs=require('fs');
const html=fs.readFileSync('public/index.html','utf8');
const target='showToast("Проверьте список отзывов — возможно, отзыв уже отправлен");';
console.log('contains target:', html.includes(target));
console.log('index:', html.indexOf(target));
