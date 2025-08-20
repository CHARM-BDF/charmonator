// script.js

import { Message, TranscriptFragment } from './src/charmonator/v1/transcript.mjs' ;
import { ImageAttachment, DocumentAttachment } from './src/charmonator/v1/transcript.mjs';

// API url:
const CHARMONATOR_API_URL = './api/charmonator/v1'; // Adjust if needed

// DOM Elements
const chatMain = document.getElementById('chatMain');
const thinkingIndicator = document.getElementById('thinkingIndicator');

const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

const fileInput = document.getElementById('fileInput');
const attachmentsContainer = document.getElementById('attachments');
const dropArea = document.getElementById('dropArea');

const appTitleText = document.getElementById('appTitle');

const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

const modelSelect = document.getElementById('modelSelect');
const activeModelDisplay = document.getElementById('activeModelDisplay');

const systemMessageInput = document.getElementById('systemMessage');
const temperatureInput = document.getElementById('temperature');

/**
 * Extended the allowed file types to include images
 */
const allowedUploadExtensions = [
  '.txt', '.md', '.docx', '.pdf', '.py', '.js', '.java', '.c', '.cpp', '.cs',
  '.rb', '.go', '.rs', '.php', '.html', '.css', '.json', '.xml', '.sh', '.bat',
  '.jpg', '.jpeg', '.png', '.gif'
];

// The current conversation transcript to date:
let currentTranscript = new TranscriptFragment();

// Instead of separate doc array, we unify them:
let pendingAttachments = [];

/**
 * The code for loading the possible models, storing settings, etc.
 * remains mostly unchanged below...
 */

let hash_encoded = window.location.hash.slice(1);
let hash_params = {};
if (hash_encoded) {
  // Handle simple hash values like #debug
  if (hash_encoded === 'debug') {
    hash_params = { debug: true };
  } else {
    // Try to decode as base64 JSON, with error handling
    try {
      hash_params = JSON.parse(atob(hash_encoded));
    } catch (error) {
      console.warn('Failed to decode hash as base64 JSON:', error.message);
      console.warn('Hash value:', hash_encoded);
      if (window.debugLog) {
        window.debugLog('Hash parameter parsing failed', { error: error.message, hash: hash_encoded });
      }
      hash_params = {};
    }
  }
}
console.log("base64-encoded hash params:", hash_params);

let isPlaygroundMode = false;
if (hash_params.playground) {
  isPlaygroundMode = true;
  console.log("Playground mode detected.");
}

// Marked config
marked.setOptions({
  breaks: true,
  gfm: true,
});

if (isPlaygroundMode) {
  document.getElementById('playgroundOptions').classList.remove('hidden');
  settingsMenu.classList.add('playground-mode');
  closeSettingsBtn.classList.remove('hidden');
}

systemMessageInput.value = hash_params.system || '';
temperatureInput.value = hash_params.temperature || 0.8;

settingsBtn.addEventListener('click', () => {
  settingsMenu.classList.toggle('hidden');
});

if (isPlaygroundMode) {
  closeSettingsBtn.addEventListener('click', () => {
    settingsMenu.classList.add('hidden');
  });
} else {
  document.addEventListener('click', (event) => {
    if (!settingsMenu.contains(event.target) && !settingsBtn.contains(event.target)) {
      settingsMenu.classList.add('hidden');
    }
  });
}

document.addEventListener('click', (event) => {
  if (!settingsMenu.contains(event.target) && !settingsBtn.contains(event.target)) {
    settingsMenu.classList.add('hidden');
  }
});

// Load saved model from localStorage
const savedModel = localStorage.getItem('selectedModel') || 'o1';

// Fetch / populate model list
async function loadAvailableModels() {
  console.log("Available models loading...");
  let response;
  let rawResponseText = '';
  try {
    response = await fetch('./api/charmonator/v1/options');
    
    // Capture full response details for debugging
    const responseDetails = {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: {}
    };
    
    // Capture response headers
    for (const [key, value] of response.headers.entries()) {
      responseDetails.headers[key] = value;
    }
    
    // Get raw response text FIRST for debugging (before parsing as JSON)
    try {
      rawResponseText = await response.text();
      if (window.debugLog) {
        window.debugLog('Raw response from ./api/charmonator/v1/options', {
          ...responseDetails,
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length
        });
      }
    } catch (textError) {
      rawResponseText = 'Unable to read response body';
      if (window.debugLog) {
        window.debugLog('Failed to read raw response text', { 
          ...responseDetails, 
          textError: textError.message 
        });
      }
    }
    
    if (!response.ok) {
      const errorDetails = {
        ...responseDetails,
        responseBody: rawResponseText
      };
      
      if (window.debugLog) {
        window.debugLog('Model loading HTTP error', errorDetails);
      }
      
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // Now try to parse the raw text as JSON
    let data;
    try {
      data = JSON.parse(rawResponseText);
      if (window.debugLog) {
        window.debugLog('Successfully parsed JSON response', {
          parsedData: data,
          rawTextLength: rawResponseText.length
        });
      }
    } catch (parseError) {
      if (window.debugLog) {
        window.debugLog('JSON parse error', {
          parseError: parseError.message,
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length,
          responseHeaders: responseDetails.headers
        });
      }
      throw new Error(`Failed to parse JSON response: ${parseError.message}`);
    }
    
    modelSelect.innerHTML = '';
    
    data.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      option.title = model.description;
      modelSelect.appendChild(option);
    });

    const savedModel = localStorage.getItem('selectedModel');
    if (savedModel && data.models.some(m => m.id === savedModel)) {
      setModel(savedModel);
    } else if (data.models.length > 0) {
      setModel(data.models[0].id);
    }

    if (window.debugLog) {
      window.debugLog('Models loaded successfully', { 
        count: data.models.length,
        models: data.models.map(m => ({ id: m.id, name: m.name }))
      });
    }

  } catch (error) {
    console.error('Error loading models:', error);
    
    const errorDetails = {
      error: error.message,
      stack: error.stack,
      url: './api/charmonator/v1/options',
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString()
    };
    
    // Add response details if we have them
    if (response) {
      errorDetails.httpStatus = response.status;
      errorDetails.httpStatusText = response.statusText;
      errorDetails.responseUrl = response.url;
    }
    
    if (window.debugLog) {
      window.debugLog('Model loading failed', errorDetails);
    }
    
    const errorOption = document.createElement('option');
    errorOption.textContent = 'Error loading models';
    errorOption.disabled = true;
    modelSelect.appendChild(errorOption);
  }
}
document.addEventListener('DOMContentLoaded', loadAvailableModels);

async function setModel(modelId) {
  let rawResponseText = '';
  try {
    const response = await fetch('./api/charmonator/v1/models');
    
    // Get raw response text FIRST for debugging
    try {
      rawResponseText = await response.text();
      if (window.debugLog) {
        window.debugLog('Raw response from ./api/charmonator/v1/options (setModel)', {
          modelId,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length
        });
      }
    } catch (textError) {
      rawResponseText = 'Unable to read response body';
      if (window.debugLog) {
        window.debugLog('Failed to read raw response text (setModel)', { 
          modelId,
          status: response.status,
          textError: textError.message 
        });
      }
    }
    
    if (!response.ok) {
      if (window.debugLog) {
        window.debugLog('SetModel HTTP error', {
          modelId,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          responseBody: rawResponseText
        });
      }
      
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // Parse the raw response as JSON
    let data;
    try {
      data = JSON.parse(rawResponseText);
      if (window.debugLog) {
        window.debugLog('Successfully parsed JSON in setModel', {
          modelId,
          parsedData: data,
          rawTextLength: rawResponseText.length
        });
      }
    } catch (parseError) {
      if (window.debugLog) {
        window.debugLog('JSON parse error in setModel', {
          modelId,
          parseError: parseError.message,
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length
        });
      }
      throw new Error(`Failed to parse JSON response: ${parseError.message}`);
    }
    const model = data.models.find(m => m.id === modelId);
    
    localStorage.setItem('selectedModel', modelId);
    modelSelect.value = modelId;
    
    if (model) {
      activeModelDisplay.textContent = `${model.name}`;
      activeModelDisplay.title = model.description;
    } else {
      activeModelDisplay.textContent = `Model: ${modelId}`;
      if (window.debugLog) {
        window.debugLog('Model not found in list', { 
          requestedModelId: modelId, 
          availableModels: data.models.map(m => m.id) 
        });
      }
    }
  } catch (error) {
    console.error('Error setting model:', error);
    if (window.debugLog) {
      window.debugLog('Model setting failed', { 
        modelId, 
        error: error.message,
        stack: error.stack,
        userAgent: navigator.userAgent
      });
    }
    activeModelDisplay.textContent = `Model: ${modelId}`;
  }
}
setModel(savedModel);
if (hash_params.model) {
  setModel(hash_params.model);
}
modelSelect.addEventListener('change', (event) => {
  setModel(event.target.value);
});






// Check if a specialized mode is enabled:
if (hash_params.mode) {
  console.log("Specialized mode detected:", hash_params.mode);
  let mode = hash_params.mode;

  let title = mode.title ;
  let model = mode.model ;

  let instructions = mode.instructions ;

  let disableSettings = mode.disableSettings ;

  setModel(model) ;

  appTitleText.textContent = title ;

  // Set the papge title as well:
  document.title = title ;

  addMessage(instructions, 'assistant');

  if (disableSettings) {
    settingsMenu.style.display = 'none';
    settingsBtn.style.display = 'none';
    activeModelDisplay.style.display = 'none';
  }

}




/**
 * Render a message in the chat UI
 */
function addMessage(content, role) {
  const messageElem = document.createElement('div');
  messageElem.classList.add('message', role);

  const bubble = document.createElement('div');
  bubble.classList.add('bubble');

  // Convert markdown to HTML
  let htmlContent = marked.parse(content);
  htmlContent = DOMPurify.sanitize(htmlContent);
  bubble.innerHTML = htmlContent;

  // Copy button(s)
  const copyTextBtn = document.createElement('button');
  copyTextBtn.classList.add('copy-btn');
  copyTextBtn.innerText = 'Copy Text';
  copyTextBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(content);
  });

  const copyFormattedBtn = document.createElement('button');
  copyFormattedBtn.classList.add('copy-btn');
  copyFormattedBtn.innerText = 'Copy w/ Formatting';
  copyFormattedBtn.addEventListener('click', () => {
    const range = document.createRange();
    range.selectNodeContents(bubble);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const copyBtnContainer = bubble.querySelector('.copy-btn-container');
    if (copyBtnContainer) {
      copyBtnContainer.style.display = 'none';
    }

    navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([bubble.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([bubble.innerText], { type: 'text/plain' }),
      }),
    ])
      .then(() => {
        selection.removeAllRanges();
        if (copyBtnContainer) {
          copyBtnContainer.style.display = 'flex';
        }
      })
      .catch((err) => {
        console.error('Failed to copy: ', err);
        if (window.debugLog) {
          window.debugLog('Clipboard copy failed', { error: err.message });
        }
        if (copyBtnContainer) {
          copyBtnContainer.style.display = 'flex';
        }
      });
  });

  const copyBtnContainer = document.createElement('div');
  copyBtnContainer.classList.add('copy-btn-container');
  copyBtnContainer.appendChild(copyTextBtn);
  copyBtnContainer.appendChild(copyFormattedBtn);

  // Code blocks -> add "Copy Code"
  const codeBlocks = bubble.querySelectorAll('pre');
  codeBlocks.forEach((codeBlock) => {
    const copyBtn = document.createElement('button');
    copyBtn.classList.add('copy-btn');
    copyBtn.innerText = 'Copy Code';
    copyBtn.addEventListener('click', () => {
      const codeText = codeBlock.innerText;
      navigator.clipboard.writeText(codeText).then(() => {
        alert('Code copied to clipboard!');
      }).catch((err) => {
        console.error('Failed to copy code: ', err);
        if (window.debugLog) {
          window.debugLog('Code copy to clipboard failed', { error: err.message });
        }
      });
    });
    codeBlock.parentElement.insertBefore(copyBtn, codeBlock);
  });

  bubble.appendChild(copyBtnContainer);
  messageElem.appendChild(bubble);
  chatMain.appendChild(messageElem);
  chatMain.scrollTop = chatMain.scrollHeight;
}

/**
 * Validate file (extension + size)
 */
function validateFile(file) {
  const maxFileSize = 50 * 1024 * 1024; // 50 MB
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

  if (!allowedUploadExtensions.includes(ext)) {
    const message = `File extension not allowed: ${file.name}`;
    alert(message);
    if (window.debugLog) {
      window.debugLog('File validation failed', { fileName: file.name, extension: ext, reason: 'extension not allowed' });
    }
    return false;
  }
  if (file.size > maxFileSize) {
    const message = `File is too large (max 50 MB): ${file.name}`;
    alert(message);
    if (window.debugLog) {
      window.debugLog('File validation failed', { fileName: file.name, fileSize: file.size, maxSize: maxFileSize, reason: 'file too large' });
    }
    return false;
  }
  return true;
}

/**
 * If file is an image, we skip /api/charmonator/v1/conversion and read it as base64 in the browser.
 */
async function uploadAndConvertImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      // e.target.result is "data:image/jpeg;base64,...."
      resolve(e.target.result);
    };
    reader.onerror = (err) => {
      if (window.debugLog) {
        window.debugLog('FileReader error', { error: err, fileName: file?.name });
      }
      reject(err);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * If file is a text/doc, we use /api/convert
 */
async function uploadAndConvertDocFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('./api/charmonator/v1/conversion/file', {
      method: 'POST',
      body: formData,
    });
    
    // Get raw response for debugging
    let rawResponseText = '';
    try {
      rawResponseText = await response.text();
      if (window.debugLog) {
        window.debugLog('Raw response from file conversion', {
          fileName: file?.name,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length
        });
      }
    } catch (textError) {
      rawResponseText = 'Unable to read response body';
      if (window.debugLog) {
        window.debugLog('Failed to read conversion response text', { 
          fileName: file?.name,
          status: response.status,
          textError: textError.message 
        });
      }
    }
    
    if (response.ok) {
      try {
        const data = JSON.parse(rawResponseText);
        if (window.debugLog) {
          window.debugLog('Successfully parsed conversion JSON', {
            fileName: file?.name,
            hasMarkdownContent: !!data.markdownContent,
            contentLength: data.markdownContent?.length || 0
          });
        }
        return data.markdownContent;
      } catch (parseError) {
        if (window.debugLog) {
          window.debugLog('JSON parse error in file conversion', {
            fileName: file?.name,
            parseError: parseError.message,
            rawResponseText: rawResponseText,
            responseLength: rawResponseText.length
          });
        }
        alert('Error: Failed to parse conversion response');
        return null;
      }
    } else {
      try {
        const errorData = JSON.parse(rawResponseText);
        const message = `Error converting file: ${errorData.error}`;
        alert(message);
        if (window.debugLog) {
          window.debugLog('File conversion API error', { fileName: file?.name, status: response.status, error: errorData.error, rawResponse: rawResponseText });
        }
      } catch (parseError) {
        if (window.debugLog) {
          window.debugLog('Failed to parse error response from file conversion', {
            fileName: file?.name,
            status: response.status,
            rawResponseText: rawResponseText,
            parseError: parseError.message
          });
        }
        alert(`Error converting file: HTTP ${response.status}`);
      }
      return null;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    if (window.debugLog) {
      window.debugLog('File upload/conversion failed', { fileName: file?.name, error: error.message, stack: error.stack });
    }
    alert('An error occurred while uploading the file.');
    return null;
  }
}

/**
 * Show attachments in the UI
 */
function displayAttachment(attachmentObj) {
  // attachmentObj has { type, fileName, content (base64 or text) }
  const attachmentElem = document.createElement('div');
  attachmentElem.classList.add('attachment-item');

  const fileNameSpan = document.createElement('span');
  fileNameSpan.classList.add('attachment-name');
  fileNameSpan.textContent = attachmentObj.fileName;

  const removeBtn = document.createElement('button');
  removeBtn.classList.add('remove-attachment-btn');
  removeBtn.innerHTML = '&times;';
  removeBtn.title = 'Remove Attachment';

  removeBtn.addEventListener('click', () => {
    attachmentsContainer.removeChild(attachmentElem);
    pendingAttachments = pendingAttachments.filter(a => a !== attachmentObj);
  });

  attachmentElem.appendChild(fileNameSpan);
  attachmentElem.appendChild(removeBtn);
  attachmentsContainer.appendChild(attachmentElem);
}

/**
 * Add newly dropped or selected file
 */
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    if (!validateFile(file)) continue;

    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    let attachmentObj = null;

    // Check if it's an image extension
    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      const dataUrl = await uploadAndConvertImageFile(file);
      if (!dataUrl) {
        if (window.debugLog) {
          window.debugLog('File input image processing failed', { fileName: file.name, extension: ext });
        }
        continue;
      }
      attachmentObj = {
        type: 'image',
        fileName: file.name,
        content: dataUrl
      };
    } else {
      // Convert text/doc to markdown
      const mdText = await uploadAndConvertDocFile(file);
      if (!mdText) {
        if (window.debugLog) {
          window.debugLog('File input document processing failed', { fileName: file.name, extension: ext });
        }
        continue;
      }
      attachmentObj = {
        type: 'document',
        fileName: file.name,
        content: mdText
      };
    }

    if (attachmentObj) {
      pendingAttachments.push(attachmentObj);
      displayAttachment(attachmentObj);
    }
  }

  fileInput.value = '';
});

/**
 * Drag and Drop
 */
['dragenter', 'dragover'].forEach(eventName => {
  dropArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(eventName => {
  dropArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove('dragover');
  });
});
dropArea.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer.files);
  for (const file of files) {
    if (!validateFile(file)) continue;

    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    let attachmentObj = null;

    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      const dataUrl = await uploadAndConvertImageFile(file);
      if (!dataUrl) {
        if (window.debugLog) {
          window.debugLog('Drag & drop image processing failed', { fileName: file.name, extension: ext });
        }
        continue;
      }
      attachmentObj = {
        type: 'image',
        fileName: file.name,
        content: dataUrl
      };
    } else {
      // doc
      const mdText = await uploadAndConvertDocFile(file);
      if (!mdText) {
        if (window.debugLog) {
          window.debugLog('Drag & drop document processing failed', { fileName: file.name, extension: ext });
        }
        continue;
      }
      attachmentObj = {
        type: 'document',
        fileName: file.name,
        content: mdText
      };
    }

    if (attachmentObj) {
      pendingAttachments.push(attachmentObj);
      displayAttachment(attachmentObj);
    }
  }
});

/**
 * Show/hide thinking indicator
 */
function showThinkingIndicator() {
  const thinkingMessage = document.createElement('div');
  thinkingMessage.classList.add('message', 'thinking', 'assistant');

  const bubble = document.createElement('div');
  bubble.classList.add('bubble');

  const dotFlashing = document.createElement('div');
  dotFlashing.classList.add('dot-flashing');
  dotFlashing.appendChild(document.createElement('div'));

  bubble.appendChild(dotFlashing);
  thinkingMessage.appendChild(bubble);
  chatMain.appendChild(thinkingMessage);
  chatMain.scrollTop = chatMain.scrollHeight;
}
function hideThinkingIndicator() {
  const thinkingMessage = document.querySelector('.message.thinking');
  if (thinkingMessage) {
    thinkingMessage.remove();
  }
}

/**
 * Send message (user typed + attachments)
 */
async function sendMessage() {
  let typedText = messageInput.value.trim();
  if (!typedText && pendingAttachments.length === 0) return;

  // Display user text in chat immediately
  addMessage(typedText, 'user');

  // Build content array for the user message
  // We want to store both text + attachments
  const finalContent = [];
  if (typedText) {
    finalContent.push(typedText);
  }
  for (const att of pendingAttachments) {
    if (att.type === 'image') {
      // Convert to an ImageAttachment
      const imgAttachment = new ImageAttachment(att.content);
      finalContent.push(imgAttachment);
    } else {
      // Convert to DocumentAttachment (or just text)
      const docAttachment = new DocumentAttachment(att.fileName, att.content);
      finalContent.push(docAttachment);
    }
  }

  // Create user message
  const userMessage = new Message('user', finalContent);
  currentTranscript = currentTranscript.plus(userMessage);

  // Reset input + attachments
  messageInput.value = '';
  pendingAttachments = [];
  attachmentsContainer.innerHTML = '';

  // Show thinking indicator
  showThinkingIndicator();

  try {
    const selectedModel = modelSelect.value;
    const system = systemMessageInput.value.trim() || null;
    const temperature = parseFloat(temperatureInput.value) || 0.8;

    // Build request payload
    const payload = {
      model: selectedModel,
      system,
      temperature,
      transcript: currentTranscript.toJSON()
    };

    const response = await fetch(`${CHARMONATOR_API_URL}/transcript/extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Get raw response for debugging
    let rawResponseText = '';
    try {
      rawResponseText = await response.text();
      if (window.debugLog) {
        window.debugLog('Raw response from transcript/extension', {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length,
          requestPayload: payload
        });
      }
    } catch (textError) {
      rawResponseText = 'Unable to read response body';
      if (window.debugLog) {
        window.debugLog('Failed to read transcript extension response text', { 
          status: response.status,
          textError: textError.message 
        });
      }
    }

    // Parse response as JSON
    let data;
    try {
      data = JSON.parse(rawResponseText);
      if (window.debugLog) {
        window.debugLog('Successfully parsed transcript extension JSON', {
          parsedData: data,
          rawTextLength: rawResponseText.length
        });
      }
    } catch (parseError) {
      if (window.debugLog) {
        window.debugLog('JSON parse error in transcript extension', {
          parseError: parseError.message,
          rawResponseText: rawResponseText,
          responseLength: rawResponseText.length,
          status: response.status
        });
      }
      // For transcript extension, we still want to show a user-friendly error
      data = { error: `Failed to parse response: ${parseError.message}` };
    }
    if (response.ok) {
      const suffix = TranscriptFragment.fromJSON(data);
      currentTranscript = currentTranscript.plus(suffix);

      // Display new assistant messages
      for (const msg of suffix.messages) {
        if (msg.role === 'assistant') {
          addMessage(msg.content, 'assistant');
        }
      }
    } else {
      throw new Error(data.error || 'Something went wrong.');
    }
  } catch (error) {
    console.error(error);
    if (window.debugLog) {
      window.debugLog('Message sending failed', { 
        error: error.message, 
        stack: error.stack,
        model: modelSelect.value,
        attachments: pendingAttachments.length
      });
    }
    addMessage(`Error: ${error.message}`, 'assistant');
  } finally {
    hideThinkingIndicator();
    messageInput.disabled = false;
    sendBtn.disabled = false;
    fileInput.disabled = false;
    messageInput.focus();
  }
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
