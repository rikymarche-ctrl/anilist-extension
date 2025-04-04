# Anilist Hover Comments (Unofficial)

> Quickly view user comments by hovering over ratings in the Anilist "Following" section.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

![Anilist Hover Comments](https://imgur.com/hPQXPmv.png)

## Overview

Anilist Hover Comments enhances your Anilist experience by displaying user comments when hovering over entries in the "Following" section of anime and manga pages. No need to click through user profiles—see what your friends think instantly!

The extension is designed to be lightweight and respectful of Anilist's API, using an intelligent caching system to minimize requests while still providing up-to-date information. It stays out of your way until you need it.

## Features

- View user comments directly from anime/manga pages with a simple hover
- Smart detection: Comment icons appear only for users who left notes
- Advanced caching system prevents excessive API requests to Anilist
- Lightweight impact ensures browsing feels seamless and responsive
- Smooth animations and responsive tooltip positioning

## Browser Compatibility

Compatible with modern Chromium-based browsers, including Chrome, Edge, and Brave.
## Installation

Installation steps are similar across browsers:

1. Download the latest release from the [Releases](https://github.com/rikymarche-ctrl/anilist-extension/releases) page
2. Unzip the file to a location of your choice
3. Go to your browser's extensions page:
    - Chrome: `chrome://extensions/`
    - Edge: `edge://extensions/`
    - Brave: `brave://extensions/`
    - Other browsers: Check your browser's menu for the extensions/add-ons section
4. Enable "Developer mode" (usually a toggle in the top-right corner)
5. Click "Load unpacked" and select the extension directory (unzipped)

## Usage

1. Navigate to any anime or manga page on [Anilist](https://anilist.co)
2. Look for comment icons (💬) next to user entries in the "Following" section
3. Hover over an icon to see the user's comment
4. Click the refresh button in the tooltip to fetch the latest comment

## Privacy

This extension:
- Works exclusively on anilist.co
- Stores comments locally in your browser for caching purposes
- Makes API requests only to the official Anilist GraphQL endpoint
- Does not collect or transmit any personal data

## Development

### Prerequisites
- Basic knowledge of JavaScript, HTML, and CSS
- Web browser with developer tools

### Local Setup
```bash
# Clone the repository
git clone https://github.com/rikymarche-ctrl/anilist-extension.git

# Navigate to project directory
cd anilist-extension

# Load the extension in your browser following the installation steps
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE.txt) file for details.

---

Made with ❤️ for the Anilist community