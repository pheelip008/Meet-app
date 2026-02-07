const fs = require('fs');

function generateBoxShadow(n) {
    let value = '';
    for (let i = 0; i < n; i++) {
        const x = Math.floor(Math.random() * 2000);
        const y = Math.floor(Math.random() * 2000);
        value += `${x}px ${y}px #FFF`;
        if (i < n - 1) value += ', ';
    }
    return value;
}

const smallStars = generateBoxShadow(700);
const mediumStars = generateBoxShadow(200);
const largeStars = generateBoxShadow(100);

const cssContent = `
/* Generated Stars */
.stars {
  width: 1px;
  height: 1px;
  background: transparent;
  box-shadow: ${smallStars};
  animation: animStar 50s linear infinite;
}

.stars::after {
  content: " ";
  position: absolute;
  top: 2000px;
  width: 1px;
  height: 1px;
  background: transparent;
  box-shadow: ${smallStars};
}

.stars2 {
  width: 2px;
  height: 2px;
  background: transparent;
  box-shadow: ${mediumStars};
  animation: animStar 100s linear infinite;
}

.stars2::after {
  content: " ";
  position: absolute;
  top: 2000px;
  width: 2px;
  height: 2px;
  background: transparent;
  box-shadow: ${mediumStars};
}

.stars3 {
  width: 3px;
  height: 3px;
  background: transparent;
  box-shadow: ${largeStars};
  animation: animStar 150s linear infinite;
}

.stars3::after {
  content: " ";
  position: absolute;
  top: 2000px;
  width: 3px;
  height: 3px;
  background: transparent;
  box-shadow: ${largeStars};
}

@keyframes animStar {
  from {
    transform: translateY(0px);
  }
  to {
    transform: translateY(-2000px);
  }
}
`;

console.log(cssContent);
