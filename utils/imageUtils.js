const fs = require('fs');
const path = require('path');

/**
 * Check if an image file exists on the server
 * @param {string} imageUrl - The relative image URL (e.g., '/uploads/properties/26/image.jpg')
 * @returns {boolean} - True if file exists, false otherwise
 */
function imageExists(imageUrl) {
  if (!imageUrl) return false;
  
  try {
    // Remove leading slash and construct full path
    const relativePath = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
    const fullPath = path.join(__dirname, '..', 'public', relativePath);
    
    return fs.existsSync(fullPath);
  } catch (error) {
    console.error('Error checking image existence:', error);
    return false;
  }
}

/**
 * Filter out non-existent images from an array of image objects
 * @param {Array} images - Array of image objects with image_url property
 * @returns {Array} - Filtered array containing only existing images
 */
function filterExistingImages(images) {
  if (!Array.isArray(images)) return [];
  
  return images.filter(image => {
    const exists = imageExists(image.image_url);
    if (!exists && image.image_url && process.env.NODE_ENV === 'development') {
      console.warn(`⚠️ Filtering out missing image: ${image.image_url}`);
    }
    return exists;
  });
}

module.exports = {
  imageExists,
  filterExistingImages
};