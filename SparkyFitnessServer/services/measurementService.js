const measurementRepository = require('../models/measurementRepository');
const userRepository = require('../models/userRepository');
const exerciseRepository = require('../models/exerciseRepository'); // For active calories
const waterContainerRepository = require('../models/waterContainerRepository'); // Import waterContainerRepository
const { log } = require('../config/logging');

async function processHealthData(healthDataArray, userId) {
  const processedResults = [];
  const errors = [];

  for (const dataEntry of healthDataArray) {
    const { value, type, unit, date } = dataEntry;

    if (!value || !type || !date) {
      errors.push({ error: "Missing required fields: value, type, date in one of the entries", entry: dataEntry });
      continue;
    }

    let parsedDate;
    try {
      const dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        throw new Error(`Invalid date received from shortcut: '${date}'.`);
      }
      parsedDate = dateObj.toISOString().split('T')[0];
    } catch (e) {
      log('error', "Date parsing error:", e);
      errors.push({ error: `Invalid date format for entry: ${JSON.stringify(dataEntry)}. Error: ${e.message}`, entry: dataEntry });
      continue;
    }

    try {
      let result;
      switch (type) {
        case 'step':
          const stepValue = parseInt(value, 10);
          if (isNaN(stepValue) || !Number.isInteger(stepValue)) {
            errors.push({ error: "Invalid value for step. Must be an integer.", entry: dataEntry });
            break;
          }
          result = await measurementRepository.upsertStepData(userId, stepValue, parsedDate);
          processedResults.push({ type, status: 'success', data: result });
          break;
        case 'water':
          const waterValue = parseInt(value, 10);
          if (isNaN(waterValue) || !Number.isInteger(waterValue)) {
            errors.push({ error: "Invalid value for water. Must be an integer.", entry: dataEntry });
            break;
          }
          result = await measurementRepository.upsertWaterData(userId, waterValue, parsedDate);
          processedResults.push({ type, status: 'success', data: result });
          break;
        case 'Active Calories':
          const activeCaloriesValue = parseFloat(value);
          if (isNaN(activeCaloriesValue) || activeCaloriesValue < 0) {
            errors.push({ error: "Invalid value for active_calories. Must be a non-negative number.", entry: dataEntry });
            break;
          }
          const exerciseId = await exerciseRepository.getOrCreateActiveCaloriesExercise(userId);
          result = await exerciseRepository.upsertExerciseEntryData(userId, exerciseId, activeCaloriesValue, parsedDate);
          processedResults.push({ type, status: 'success', data: result });
          break;
        default:
          errors.push({ error: `Unsupported health data type: ${type}`, entry: dataEntry });
          break;
      }
    } catch (error) {
      log('error', `Error processing health data entry ${JSON.stringify(dataEntry)}:`, error);
      errors.push({ error: `Failed to process entry: ${error.message}`, entry: dataEntry });
    }
  }

  if (errors.length > 0) {
    throw new Error(JSON.stringify({
      message: "Some health data entries could not be processed.",
      processed: processedResults,
      errors: errors
    }));
  } else {
    return {
      message: "All health data successfully processed.",
      processed: processedResults
    };
  }
}

async function getWaterIntake(authenticatedUserId, targetUserId, date) {
  try {
    const waterData = await measurementRepository.getWaterIntakeByDate(targetUserId, date);
    return waterData || { glasses_consumed: 0 };
  } catch (error) {
    log('error', `Error fetching water intake for user ${targetUserId} on ${date} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function upsertWaterIntake(authenticatedUserId, entryDate, changeDrinks, containerId) {
  try {
    // 1. Get current water intake for the day
    const currentWaterRecord = await measurementRepository.getWaterIntakeByDate(authenticatedUserId, entryDate);
    const currentWaterMl = currentWaterRecord ? Number(currentWaterRecord.water_ml) : 0;

    // 2. Determine amount per drink based on container
    let amountPerDrink;
    if (containerId) {
      const container = await waterContainerRepository.getWaterContainerById(containerId);
      if (container) {
        amountPerDrink = Number(container.volume) / Number(container.servings_per_container);
      } else {
        // Fallback to default if container not found (shouldn't happen if frontend sends valid ID)
        log('warn', `Container with ID ${containerId} not found for user ${authenticatedUserId}. Using default amount per drink.`);
        amountPerDrink = 2000 / 8; // Default: 2000ml / 8 servings
      }
    } else {
      // Use default amount per drink if no container ID is provided (e.g., for default container)
      amountPerDrink = 2000 / 8; // Default: 2000ml / 8 servings
    }

    // 3. Calculate new total water intake
    const newTotalWaterMl = Math.max(0, currentWaterMl + (changeDrinks * amountPerDrink));

    // 4. Upsert the new total water intake
    const result = await measurementRepository.upsertWaterData(authenticatedUserId, newTotalWaterMl, entryDate);
    return result;
  } catch (error) {
    log('error', `Error upserting water intake for user ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getWaterIntakeEntryById(authenticatedUserId, id) {
  try {
    const entryOwnerId = await measurementRepository.getWaterIntakeEntryOwnerId(id);
    if (!entryOwnerId) {
      throw new Error('Water intake entry not found.');
    }
    const entry = await measurementRepository.getWaterIntakeEntryById(id);
    return entry;
  } catch (error) {
    log('error', `Error fetching water intake entry ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function updateWaterIntake(authenticatedUserId, id, updateData) {
  try {
    const entryOwnerId = await measurementRepository.getWaterIntakeEntryOwnerId(id);
    if (!entryOwnerId) {
      throw new Error('Water intake entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to update this water intake entry.');
    }
    const updatedEntry = await measurementRepository.updateWaterIntake(id, authenticatedUserId, updateData);
    if (!updatedEntry) {
      throw new Error('Water intake entry not found or not authorized to update.');
    }
    return updatedEntry;
  } catch (error) {
    log('error', `Error updating water intake entry ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function deleteWaterIntake(authenticatedUserId, id) {
  try {
    const entryOwnerId = await measurementRepository.getWaterIntakeEntryOwnerId(id);
    if (!entryOwnerId) {
      throw new Error('Water intake entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to delete this water intake entry.');
    }
    const success = await measurementRepository.deleteWaterIntake(id, authenticatedUserId);
    if (!success) {
      throw new Error('Water intake entry not found.');
    }
    return { message: 'Water intake entry deleted successfully.' };
  } catch (error) {
    log('error', `Error deleting water intake entry ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function upsertCheckInMeasurements(authenticatedUserId, entryDate, measurements) {
  try {
    const result = await measurementRepository.upsertCheckInMeasurements(authenticatedUserId, entryDate, measurements);
    return result;
  } catch (error) {
    log('error', `Error upserting check-in measurements for user ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCheckInMeasurements(authenticatedUserId, targetUserId, date) {
  try {
    const measurement = await measurementRepository.getCheckInMeasurementsByDate(targetUserId, date);
    return measurement || {};
  } catch (error) {
    log('error', `Error fetching check-in measurements for user ${targetUserId} on ${date} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function updateCheckInMeasurements(authenticatedUserId, id, entryDate, updateData) {
  try {
    const entryOwnerId = await measurementRepository.getCheckInMeasurementOwnerId(id);
    if (!entryOwnerId) {
      throw new Error('Check-in measurement not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to update this check-in measurement.');
    }
    const updatedMeasurement = await measurementRepository.updateCheckInMeasurements(id, authenticatedUserId, entryDate, updateData);
    if (!updatedMeasurement) {
      throw new Error('Check-in measurement not found or not authorized to update.');
    }
    return updatedMeasurement;
  } catch (error) {
    log('error', `Error updating check-in measurements ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function deleteCheckInMeasurements(authenticatedUserId, id) {
  try {
    const entryOwnerId = await measurementRepository.getCheckInMeasurementOwnerId(id);
    if (!entryOwnerId) {
      throw new Error('Check-in measurement not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to delete this check-in measurement.');
    }
    const success = await measurementRepository.deleteCheckInMeasurements(id, authenticatedUserId);
    if (!success) {
      throw new Error('Check-in measurement not found.');
    }
    return { message: 'Check-in measurement deleted successfully.' };
  } catch (error) {
    log('error', `Error deleting check-in measurements ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCustomCategories(authenticatedUserId, targetUserId) {
  try {
    let finalUserId = authenticatedUserId;
    if (targetUserId && targetUserId !== authenticatedUserId) {
      finalUserId = targetUserId;
    }
    const categories = await measurementRepository.getCustomCategories(finalUserId);
    return categories;
  } catch (error) {
    log('error', `Error fetching custom categories for user ${targetUserId} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function createCustomCategory(authenticatedUserId, categoryData) {
  try {
    categoryData.user_id = authenticatedUserId; // Ensure user_id is set from authenticated user
    const newCategory = await measurementRepository.createCustomCategory(categoryData);
    return newCategory;
  } catch (error) {
    log('error', `Error creating custom category for user ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function updateCustomCategory(authenticatedUserId, id, updateData) {
  try {
    const categoryOwnerId = await measurementRepository.getCustomCategoryOwnerId(id);
    if (!categoryOwnerId) {
      throw new Error('Custom category not found.');
    }
    if (categoryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to update this custom category.');
    }
    const updatedCategory = await measurementRepository.updateCustomCategory(id, authenticatedUserId, updateData);
    if (!updatedCategory) {
      throw new Error('Custom category not found or not authorized to update.');
    }
    return updatedCategory;
  } catch (error) {
    log('error', `Error updating custom category ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function deleteCustomCategory(authenticatedUserId, id) {
  try {
    const categoryOwnerId = await measurementRepository.getCustomCategoryOwnerId(id);
    if (!categoryOwnerId) {
      throw new Error('Custom category not found.');
    }
    if (categoryOwnerId !== authenticatedUserId) {
      throw new Error('Forbidden: You do not have permission to delete this custom category.');
    }
    const success = await measurementRepository.deleteCustomCategory(id, authenticatedUserId);
    if (!success) {
      throw new Error('Custom category not found.');
    }
    return { message: 'Custom category deleted successfully.' };
  } catch (error) {
    log('error', `Error deleting custom category ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCustomMeasurementEntries(authenticatedUserId, targetUserId, limit, orderBy, filter) {
  try {
    const entries = await measurementRepository.getCustomMeasurementEntries(targetUserId, limit, orderBy, filter);
    return entries;
  } catch (error) {
    log('error', `Error fetching custom measurement entries for user ${targetUserId} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCustomMeasurementEntriesByDate(authenticatedUserId, targetUserId, date) {
  try {
    const entries = await measurementRepository.getCustomMeasurementEntriesByDate(targetUserId, date);
    return entries;
  } catch (error) {
    log('error', `Error fetching custom measurement entries for user ${targetUserId} on ${date} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCheckInMeasurementsByDateRange(authenticatedUserId, userId, startDate, endDate) {
  try {
    const measurements = await measurementRepository.getCheckInMeasurementsByDateRange(userId, startDate, endDate);
    return measurements;
  } catch (error) {
    log('error', `Error fetching check-in measurements for user ${userId} from ${startDate} to ${endDate} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function getCustomMeasurementsByDateRange(authenticatedUserId, userId, categoryId, startDate, endDate) {
  try {
    const measurements = await measurementRepository.getCustomMeasurementsByDateRange(userId, categoryId, startDate, endDate);
    return measurements;
  } catch (error) {
    log('error', `Error fetching custom measurements for user ${userId}, category ${categoryId} from ${startDate} to ${endDate} by ${authenticatedUserId}:`, error);
    throw error;
  }
}

module.exports = {
  processHealthData,
  getWaterIntake,
  upsertWaterIntake,
  getWaterIntakeEntryById,
  updateWaterIntake,
  deleteWaterIntake,
  upsertCheckInMeasurements,
  getCheckInMeasurements,
  updateCheckInMeasurements,
  deleteCheckInMeasurements,
  getCustomCategories,
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  getCustomMeasurementEntries,
  getCustomMeasurementEntriesByDate,
  getCheckInMeasurementsByDateRange,
  getCustomMeasurementsByDateRange,
  upsertCustomMeasurementEntry,
  deleteCustomMeasurementEntry,
};

async function upsertCustomMeasurementEntry(authenticatedUserId, payload) {
  try {
    const { category_id, value, entry_date, entry_hour, entry_timestamp } = payload;
    const result = await measurementRepository.upsertCustomMeasurement(
      authenticatedUserId,
      category_id,
      value,
      entry_date,
      entry_hour,
      entry_timestamp
    );
    return result;
  } catch (error) {
    log('error', `Error upserting custom measurement entry for user ${authenticatedUserId}:`, error);
    throw error;
  }
}

async function deleteCustomMeasurementEntry(authenticatedUserId, id) {
  try {
    const success = await measurementRepository.deleteCustomMeasurement(id, authenticatedUserId);
    if (!success) {
      throw new Error('Custom measurement entry not found or not authorized to delete.');
    }
    return { message: 'Custom measurement entry deleted successfully.' };
  } catch (error) {
    log('error', `Error deleting custom measurement entry ${id} by ${authenticatedUserId}:`, error);
    throw error;
  }
}