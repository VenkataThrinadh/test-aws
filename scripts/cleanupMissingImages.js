const { pool } = require('../db');
const fs = require('fs');
const path = require('path');

/**
 * Script to clean up database references to missing image files
 * This will help prevent 404 errors in the mobile app
 */
async function cleanupMissingImages() {
  console.log('🧹 Starting cleanup of missing image references...');
  
  try {
    // Get all property images from database
    const [images] = await pool.execute('SELECT id, property_id, image_url FROM property_images');
    
    console.log(`📊 Found ${images.length} image records in database`);
    
    let removedCount = 0;
    const imagesToRemove = [];
    
    // Check each image
    for (const image of images) {
      if (!image.image_url) {
        imagesToRemove.push(image.id);
        continue;
      }
      
      // Construct file path
      const relativePath = image.image_url.startsWith('/') ? image.image_url.substring(1) : image.image_url;
      const fullPath = path.join(__dirname, '..', 'public', relativePath);
      
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        console.log(`❌ Missing: ${image.image_url} (Property ID: ${image.property_id})`);
        imagesToRemove.push(image.id);
        removedCount++;
      }
    }
    
    // Remove missing image records from database
    if (imagesToRemove.length > 0) {
      console.log(`🗑️ Removing ${imagesToRemove.length} missing image records...`);
      
      for (const imageId of imagesToRemove) {
        await pool.execute('DELETE FROM property_images WHERE id = ?', [imageId]);
      }
      
      console.log(`✅ Removed ${removedCount} missing image references from database`);
    } else {
      console.log('✅ No missing images found - database is clean!');
    }
    
    // Summary
    console.log('\n📋 Cleanup Summary:');
    console.log(`   Total images in database: ${images.length}`);
    console.log(`   Missing images removed: ${removedCount}`);
    console.log(`   Valid images remaining: ${images.length - removedCount}`);
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

// Run cleanup if this script is executed directly
if (require.main === module) {
  cleanupMissingImages()
    .then(() => {
      console.log('🎉 Cleanup completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Cleanup failed:', error);
      process.exit(1);
    });
}

module.exports = { cleanupMissingImages };