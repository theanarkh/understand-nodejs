const fs = require('fs');
const path = require('path');
const arr = fs.readdirSync('./');
const result = [];
for (let i = 0; i< arr.length; i++) {
    if (/^(chap|README)/.test(arr[i])) {
        const content = fs.readFileSync(path.resolve(__dirname, arr[i]));
        result.push(content);
    }
}

console.log(result.join(''))