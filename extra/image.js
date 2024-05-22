const images = document.querySelectorAll('img');

for (const image of images) {
  image.setAttribute('referrerpolicy', 'no-referrer');
}
