/** Reset + shared plumbing CSS included in every rendered site. */
export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-background);min-height:100vh;display:flex;flex-direction:column}
img,svg,video{max-width:100%}
main{flex:1;display:flex;flex-direction:column}
.wb-inner{width:100%}
a{color:inherit}
:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
`;

/**
 * The only client JS a published site may include: activates click-to-load
 * video facades. Injected by the renderer only when a videoEmbed is present.
 */
export const VIDEO_FACADE_JS = `document.addEventListener('click',function(e){var b=e.target.closest('.wb-video-facade');if(!b)return;var f=document.createElement('iframe');f.src=b.dataset.embed;f.allow='autoplay; fullscreen';f.allowFullscreen=true;f.title=b.querySelector('.wb-video-title').textContent;b.replaceWith(f)});`;
