export interface VideoValidationResult {
  valid: boolean;
  videoId?: string;
  canonicalUrl?: string;
  error?: string;
}

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTNAMES = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

export function validateYouTubeUrl(input: string): VideoValidationResult {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Please enter a YouTube video URL.' };
  }

  const trimmed = input.trim();

  if (trimmed.length > 200) {
    return { 
      valid: false, 
      error: 'URL is too long (maximum 200 characters).' 
    };
  }
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid URL scheme.' 
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { 
      valid: false, 
      error: 'Please enter a valid https:// YouTube link.' 
    };
  }

  if (parsed.protocol !== 'https:') {
    return { 
      valid: false, 
      error: 'Only secure https:// YouTube links are allowed.' 
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTNAMES.includes(hostname)) {
    return { 
      valid: false, 
      error: 'Only official YouTube links (youtube.com, youtu.be) are accepted.' 
    };
  }

  let videoId: string | null = null;

  if (hostname === 'youtu.be') {
    const segment = parsed.pathname.slice(1).split('/')[0];
    if (segment && VIDEO_ID_REGEX.test(segment)) {
      videoId = segment;
    }
  } else {
    if (parsed.pathname === '/watch') {
      const v = parsed.searchParams.get('v');
      if (v && VIDEO_ID_REGEX.test(v)) {
        videoId = v;
      }
    } else if (parsed.pathname.startsWith('/embed/')) {
      const segment = parsed.pathname.split('/')[2];
      if (segment && VIDEO_ID_REGEX.test(segment)) {
        videoId = segment;
      }
    } else if (parsed.pathname.startsWith('/shorts/')) {
      const segment = parsed.pathname.split('/')[2];
      if (segment && VIDEO_ID_REGEX.test(segment)) {
        videoId = segment;
      }
    }
  }

  if (!videoId) {
    return {
      valid: false,
      error: 'Could not extract a valid 11-character YouTube video ID from the link.',
    };
  }

  return {
    valid: true,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

