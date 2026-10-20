import React from "react";
import { Plug } from "lucide-react";

// Brand marks for the KNOWN connector declarations; anything else renders a brand-colored
// monogram (MONO) or the neutral plug mark — the card itself always comes from the app's own
// connector registry.

// Официальные цветные марки: Google Calendar (2020), Outlook (2018–2024).
const GOOGLE_CALENDAR_MARK = '<g transform="translate(3.75 3.75)"><path fill="#FFFFFF" d="M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579l5.263-53.947L148.882,43.618z"/><path fill="#1A73E8" d="M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342c2.053,1.737,4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421C73.408,129.263,69.145,127.934,65.211,125.276z"/><path fill="#1A73E8" d="M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z"/><path fill="#EA4335" d="M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z"/><path fill="#34A853" d="M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z"/><path fill="#4285F4" d="M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75H12.039z"/><path fill="#188038" d="M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z"/><path fill="#FBBC04" d="M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z"/><path fill="#1967D2" d="M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z"/></g>';

const OUTLOOK_MARK = '<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="1128.4584" y1="811.0833" x2="1128.4584" y2="1.9982" gradientTransform="matrix(1 0 0 -1 0 1705.3334)"><stop offset="0" style="stop-color:#35B8F1"/><stop offset="1" style="stop-color:#28A8EA"/></linearGradient><linearGradient id="SVGID_2_" gradientUnits="userSpaceOnUse" x1="162.7469" y1="1383.0741" x2="774.0864" y2="324.2592" gradientTransform="matrix(1 0 0 -1 0 1705.3334)"><stop offset="0" style="stop-color:#1784D9"/><stop offset="0.5" style="stop-color:#107AD5"/><stop offset="1" style="stop-color:#0A63C9"/></linearGradient><path fill="#0A2767" d="M1831.083,894.25c0.1-14.318-7.298-27.644-19.503-35.131h-0.213l-0.767-0.426l-634.492-375.585c-2.74-1.851-5.583-3.543-8.517-5.067c-24.498-12.639-53.599-12.639-78.098,0c-2.934,1.525-5.777,3.216-8.517,5.067L446.486,858.693l-0.766,0.426c-19.392,12.059-25.337,37.556-13.278,56.948c3.553,5.714,8.447,10.474,14.257,13.868l634.492,375.585c2.749,1.835,5.592,3.527,8.517,5.068c24.498,12.639,53.599,12.639,78.098,0c2.925-1.541,5.767-3.232,8.517-5.068l634.492-375.585C1823.49,922.545,1831.228,908.923,1831.083,894.25z"/><path fill="#0364B8" d="M520.453,643.477h416.38v381.674h-416.38V643.477z M1745.917,255.5V80.908c1-43.652-33.552-79.862-77.203-80.908H588.204C544.552,1.046,510,37.256,511,80.908V255.5l638.75,170.333L1745.917,255.5z"/><path fill="#0078D4" d="M511,255.5h425.833v383.25H511V255.5z"/><path fill="#28A8EA" d="M1362.667,255.5H936.833v383.25L1362.667,1022h383.25V638.75L1362.667,255.5z"/><path fill="#0078D4" d="M936.833,638.75h425.833V1022H936.833V638.75z"/><path fill="#0364B8" d="M936.833,1022h425.833v383.25H936.833V1022z"/><path fill="#14447D" d="M520.453,1025.151h416.38v346.969h-416.38V1025.151z"/><path fill="#0078D4" d="M1362.667,1022h383.25v383.25h-383.25V1022z"/><path fill="url(#SVGID_1_)" d="M1811.58,927.593l-0.809,0.426l-634.492,356.848c-2.768,1.703-5.578,3.321-8.517,4.769c-10.777,5.132-22.481,8.029-34.407,8.517l-34.663-20.27c-2.929-1.47-5.773-3.105-8.517-4.897L447.167,906.003h-0.298l-21.036-11.753v722.384c0.328,48.196,39.653,87.006,87.849,86.7h1230.914c0.724,0,1.363-0.341,2.129-0.341c10.18-0.651,20.216-2.745,29.808-6.217c4.145-1.756,8.146-3.835,11.966-6.217c2.853-1.618,7.75-5.152,7.75-5.152c21.814-16.142,34.726-41.635,34.833-68.772V894.25C1831.068,908.067,1823.616,920.807,1811.58,927.593z"/><path fill="#1490DF" d="M1811.58,927.593l-0.809,0.468l-634.492,356.848c-2.768,1.703-5.578,3.321-8.517,4.769c-24.641,12.038-53.457,12.038-78.098,0c-2.918-1.445-5.76-3.037-8.517-4.769L446.657,928.061l-0.766-0.468c-12.25-6.642-19.93-19.409-20.057-33.343v722.384c0.305,48.188,39.616,87.004,87.803,86.7c0.001,0,0.002,0,0.004,0h1229.636c48.188,0.307,87.5-38.509,87.807-86.696c0-0.001,0-0.002,0-0.004V894.25C1831.068,908.067,1823.616,920.807,1811.58,927.593z"/><path fill="#28A8EA" d="M514.833,1703.333h1228.316c18.901,0.096,37.335-5.874,52.59-17.033l-697.089-408.331c-2.929-1.47-5.773-3.105-8.517-4.897L447.125,906.088h-0.298l-20.993-11.838v719.914C425.786,1663.364,465.632,1703.286,514.833,1703.333C514.832,1703.333,514.832,1703.333,514.833,1703.333z"/><path fill="url(#SVGID_2_)" d="M78.055,383.25h780.723c43.109,0,78.055,34.947,78.055,78.055v780.723c0,43.109-34.946,78.055-78.055,78.055H78.055c-43.109,0-78.055-34.947-78.055-78.055V461.305C0,418.197,34.947,383.25,78.055,383.25z"/><path fill="#FFFFFF" d="M243.96,710.631c19.238-40.988,50.29-75.289,89.17-98.495c43.057-24.651,92.081-36.94,141.675-35.515c45.965-0.997,91.321,10.655,131.114,33.683c37.414,22.312,67.547,55.004,86.742,94.109c20.904,43.09,31.322,90.512,30.405,138.396c1.013,50.043-9.706,99.628-31.299,144.783c-19.652,40.503-50.741,74.36-89.425,97.388c-41.327,23.734-88.367,35.692-136.011,34.578c-46.947,1.133-93.303-10.651-134.01-34.067c-37.738-22.341-68.249-55.07-87.892-94.28c-21.028-42.467-31.57-89.355-30.745-136.735C212.808,804.859,223.158,755.686,243.96,710.631z M339.006,941.858c10.257,25.912,27.651,48.385,50.163,64.812c22.93,16.026,50.387,24.294,78.353,23.591c29.783,1.178,59.14-7.372,83.634-24.358c22.227-16.375,39.164-38.909,48.715-64.812c10.677-28.928,15.946-59.572,15.543-90.404c0.33-31.127-4.623-62.084-14.649-91.554c-8.855-26.607-25.246-50.069-47.182-67.537c-23.88-17.79-53.158-26.813-82.91-25.55c-28.572-0.74-56.644,7.593-80.184,23.804c-22.893,16.496-40.617,39.168-51.1,65.365c-23.255,60.049-23.376,126.595-0.341,186.728L339.006,941.858z"/><path fill="#50D9FF" d="M1362.667,255.5h383.25v383.25h-383.25V255.5z"/>';

const CalendarIcon = () => (
  <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden dangerouslySetInnerHTML={{ __html: GOOGLE_CALENDAR_MARK }} />
);

const OutlookIcon = () => (
  <svg viewBox="0 0 1831.085 1703.335" className="h-full w-full" aria-hidden dangerouslySetInnerHTML={{ __html: OUTLOOK_MARK }} />
);

const DriveIcon = () => (
  <svg viewBox="0 0 87.3 78" className="h-full w-full" aria-hidden>
    <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
    <path fill="#00ac47" d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.58 9.58 0 0 0-1.2 4.5h27.5z" />
    <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 11.5z" />
    <path fill="#00832d" d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
    <path fill="#2684fc" d="M59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
    <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
  </svg>
);

const GithubIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#181717" d="M12 1.5A10.5 10.5 0 0 0 8.7 22c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.2-3.5-1.2-.5-1.2-1.2-1.6-1.2-1.6-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.8-1.2-4.8-5.1 0-1.1.4-2 1-2.7-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.7 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z" />
  </svg>
);

const MicrosoftIcon = OutlookIcon;

const GmailIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#4285f4" d="M22 6.5v11a1.5 1.5 0 0 1-1.5 1.5H19V9.4l-7 5.2-7-5.2V19H3.5A1.5 1.5 0 0 1 2 17.5v-11c0-1.2 1.4-1.9 2.4-1.2L12 10.6l7.6-5.3c1-.7 2.4 0 2.4 1.2z" />
    <path fill="#ea4335" d="M2 6.5 4.4 6l7.6 5.6V19H3.5A1.5 1.5 0 0 1 2 17.5v-11z" opacity="0.9" />
    <path fill="#c5221f" d="m22 6.5-2.4-.5L12 11.6V19h8.5A1.5 1.5 0 0 0 22 17.5v-11z" opacity="0.85" />
    <path fill="#fbbc04" d="m4.4 6 2.9 2.1L2 12V6.5L4.4 6z" />
    <path fill="#34a853" d="m19.6 6-2.9 2.1L22 12V6.5L19.6 6z" />
  </svg>
);

const DocsIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#4285f4" d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7l-5-5z" />
    <path fill="#a1c2fa" d="M14 2l5 5h-5V2z" />
    <path fill="#fff" d="M8 11h8v1.4H8V11zm0 2.8h8v1.4H8v-1.4zm0 2.8h5.5v1.4H8v-1.4z" />
  </svg>
);

const SheetsIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#0f9d58" d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7l-5-5z" />
    <path fill="#9bdcb0" d="M14 2l5 5h-5V2z" />
    <path fill="#fff" d="M8 11h8v7H8v-7zm1.4 1.4v1.4h2.2v-1.4H9.4zm3.6 0v1.4h1.6v-1.4H13zm-3.6 2.8v1.4h2.2v-1.4H9.4zm3.6 0v1.4h1.6v-1.4H13z" />
  </svg>
);

const SlidesIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#f4b400" d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7l-5-5z" />
    <path fill="#f7c873" d="M14 2l5 5h-5V2z" />
    <path fill="#fff" d="M8 11h8v6H8v-6z" />
  </svg>
);

const IntercomIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#286efa" />
    <path fill="#fff" d="M7 7.5c0-.6.5-1 1-1s1 .4 1 1v5.4c0 .6-.4 1-1 1s-1-.4-1-1V7.5zm4-1.3c0-.6.5-1 1-1s1 .4 1 1v7.2c0 .6-.4 1-1 1s-1-.4-1-1V6.2zm4 1.3c0-.6.5-1 1-1s1 .4 1 1v5.4c0 .6-.4 1-1 1s-1-.4-1-1V7.5zM7.2 16.2c2.9 1.5 6.7 1.5 9.6 0 .5-.2 1 0 1.2.4.2.5 0 1-.4 1.2-3.4 1.7-7.8 1.7-11.2 0-.5-.2-.6-.8-.4-1.2.2-.5.7-.7 1.2-.4z" />
  </svg>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <defs>
      <radialGradient id="igGrad" cx="0.3" cy="1.1" r="1.3">
        <stop offset="0" stopColor="#ffdd55" />
        <stop offset="0.45" stopColor="#ff543e" />
        <stop offset="0.75" stopColor="#c837ab" />
        <stop offset="1" stopColor="#8a3ab9" />
      </radialGradient>
    </defs>
    <rect x="2" y="2" width="20" height="20" rx="5.5" fill="url(#igGrad)" />
    <rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="#fff" strokeWidth="1.7" />
    <circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" strokeWidth="1.7" />
    <circle cx="16.2" cy="7.8" r="1" fill="#fff" />
  </svg>
);

const SlackIcon = () => (
  <svg viewBox="0 0 122.8 122.8" className="h-full w-full" aria-hidden>
    <path fill="#e01e5a" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" />
    <path fill="#36c5f0" d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" />
    <path fill="#2eb67d" d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" />
    <path fill="#ecb22e" d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" />
  </svg>
);

const NotionIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="3" fill="#fff" stroke="#d4d4d4" />
    <path fill="#111" d="M7 17.5V6.5h2.2l5.6 8.2V6.5H17v11h-2.1L9.2 9v8.5H7z" />
  </svg>
);

const LinkedinIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="3" fill="#0a66c2" />
    <path fill="#fff" d="M7.6 9.4v8H5.2v-8h2.4zM6.4 5.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM9.7 9.4h2.3v1.1c.4-.7 1.3-1.3 2.6-1.3 2 0 3.2 1.2 3.2 3.6v4.6h-2.4v-4.2c0-1.3-.5-2-1.5-2-1.1 0-1.8.8-1.8 2.1v4.1H9.7v-8z" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="4" fill="#000" />
    <path fill="#fff" d="M5 5h3.6l4 5.3L17.2 5H19l-5.5 6.4L19.4 19h-3.6l-4.3-5.7L6.6 19H5l5.9-6.9L5 5z" />
  </svg>
);

const DropboxIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#0061ff" d="M7 2 1 5.9l6 3.9 6-3.9L7 2zm10 0-6 3.9 6 3.9 6-3.9L17 2zM1 13.7l6 3.9 6-3.9-6-3.9-6 3.9zm16-3.9-6 3.9 6 3.9 6-3.9-6-3.9zM7 18.9l6 3.9 6-3.9-6-3.8-6 3.8z" />
  </svg>
);

const ICONS = {
  googlecalendar: CalendarIcon,
  googledrive: DriveIcon,
  github: GithubIcon,
  microsoft: MicrosoftIcon,
  gmail: GmailIcon,
  googledocs: DocsIcon,
  googlesheets: SheetsIcon,
  googleslides: SlidesIcon,
  intercom: IntercomIcon,
  instagram: InstagramIcon,
  slack: SlackIcon,
  slackbot: SlackIcon,
  notion: NotionIcon,
  linkedin: LinkedinIcon,
  x: XIcon,
  dropbox: DropboxIcon,
};

// Brand-colored monograms for connectors without a drawn mark.
const MONO = {
  googlecontacts: "#4285f4", googlephotos: "#4285f4", googleforms: "#4285f4", googleworkspace: "#4285f4",
  googlemeet: "#4285f4", googletasks: "#4285f4", googleanalytics: "#e37400", googlesearchconsole: "#4285f4",
  googlebigquery: "#4285f4", googleclassroom: "#4285f4",
  outlook: "#0078d4", microsoft_teams: "#4b53bc", share_point: "#038387", one_drive: "#0078d4",
  microsoft_graph: "#0078d4", excel: "#107c41", microsoft_powerpoint: "#d24726", microsoft_word: "#2b579a", one_note: "#7719aa",
  salesforce: "#00a1e0", hubspot: "#ff7a59", tiktok: "#111111", discord: "#5865f2", wix: "#0c6efc",
  gitlab: "#fc6d26", clickup: "#7b68ee", wrike: "#0a1f44", box: "#0061d5", linear: "#5e6ad2",
  airtable: "#fcb400", typeform: "#262627", splitwise: "#1c9e6d", hugging_face: "#ffd21e", calendly: "#006bff",
  quickbooks: "#2ca01c", square: "#111111", asana: "#f06a6a", attio: "#2467ff", basecamp: "#1d2d35",
  docusign: "#f7c600", eventbrite: "#f05537", facebook_pages: "#1877f2", freshbooks: "#0071bc",
  harvest: "#fa5d29", mailchimp: "#ffe01b", miro: "#ffd02f", moneybird: "#0fb2b2", pagerduty: "#0b8446",
  sentry: "#362d59", todoist: "#e44332", twitch: "#9146ff", wave: "#1c2b4a", wordpress_com: "#21759b",
  zohocrm: "#e42527", klaviyo: "#111111", contentful: "#3c7de0", gorgias: "#fb3f4c", gumroad: "#ff90e8",
  polar: "#2563eb", bamboohr: "#67c437",
};

const Monogram = ({ color, letter }) => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="4.5" fill={color} />
    <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">{letter}</text>
  </svg>
);

export default function ConnectorIcon({ name, className = "h-9 w-9" }) {
  const Icon = ICONS[name];
  const monoColor = MONO[name];
  const letter = (name[0] || "?").toUpperCase();
  return (
    <span className={`${className} grid shrink-0 place-items-center rounded-lg border border-border bg-muted/40 p-1.5`}>
      {Icon ? <Icon /> : monoColor ? <Monogram color={monoColor} letter={letter} /> : <Plug className="h-4 w-4 text-muted-foreground" />}
    </span>
  );
}